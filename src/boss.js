const EventEmitter = require('events')
const plans = require('./plans')
const { states } = require('./plans')
const { COMPLETION_JOB_PREFIX } = plans

const queues = {
  MAINTENANCE: '__pgboss__maintenance',
  MONITOR_STATES: '__pgboss__monitor-states'
}

const events = {
  error: 'error',
  monitorStates: 'monitor-states',
  maintenance: 'maintenance'
}

// flag values below are interpolated straight into SQL; only allow simple
// "<number> <optional unit>" strings (e.g. '30s', '21600 seconds') so a
// bad/malicious ConfigCat edit can't break the query or inject
const INTERVAL_PATTERN = /^\d+\s*(ms|s|m|h|d|seconds?|minutes?|hours?|days?)?$/i
const isSQLInterval = (value) => typeof value === 'string' && INTERVAL_PATTERN.test(value.trim())

// Check we have a feature flag client with the required lookup method/func and use this to pull
// the maintenance query params from the feature flag `archiveConfigFlagName`.
//
// @returns JSON | null
const getMaintenanceConfigFromFlag = async (config, emitError) => {
  let flag = null

  const {
    featureFlagClient: client,
    archiveConfigFlagName: flagName
  } = config;

  if(
    !client
    || typeof client.getValueAsync !== 'function'
    || !flagName
  ){
    return flag
  }

  try {
    // ConfigCat auto-polls every 60s; getValueAsync reads the in-memory cache, no network call per invocation
    const f = await client.getValueAsync(flagName, null)
    flag = f ? JSON.parse(f) : null
  } catch (_err) { /* FF unavailable or unparseable — fall back to configured defaults */ }

  if (!flag) {
    emitError(new Error(`[pg-boss] could not fetch/parse ${flagName} flag; using configured defaults`))
  }

  return flag;
}

class Boss extends EventEmitter {
  constructor (db, config) {
    super()

    this.db = db
    this.config = config
    this.manager = config.manager

    this.maintenanceIntervalSeconds = config.maintenanceIntervalSeconds

    this.monitorStates = config.monitorStateIntervalSeconds !== null

    if (this.monitorStates) {
      this.monitorIntervalSeconds = config.monitorStateIntervalSeconds
    }

    this.events = events

    this.expireCommand = plans.locked(config.schema, plans.expire(config.schema))
    this.purgeCommand = plans.locked(config.schema, plans.purge(config.schema, config.deleteAfter))
    this.getMaintenanceTimeCommand = plans.getMaintenanceTime(config.schema)
    this.setMaintenanceTimeCommand = plans.setMaintenanceTime(config.schema)
    this.countStatesCommand = plans.countStates(config.schema)

    this.functions = [
      this.expire,
      this.archive,
      this.purge,
      this.countStates,
      this.getQueueNames
    ]
  }

  async supervise () {
    this.metaMonitor()

    await this.manager.deleteQueue(COMPLETION_JOB_PREFIX + queues.MAINTENANCE)
    await this.manager.deleteQueue(queues.MAINTENANCE)

    await this.maintenanceAsync()

    const maintenanceWorkOptions = {
      newJobCheckIntervalSeconds: Math.max(1, this.maintenanceIntervalSeconds / 2)
    }

    await this.manager.work(queues.MAINTENANCE, maintenanceWorkOptions, (job) => this.onMaintenance(job))

    if (this.monitorStates) {
      await this.manager.deleteQueue(COMPLETION_JOB_PREFIX + queues.MONITOR_STATES)
      await this.manager.deleteQueue(queues.MONITOR_STATES)

      await this.monitorStatesAsync()

      const monitorStatesWorkOptions = {
        newJobCheckIntervalSeconds: Math.max(1, this.monitorIntervalSeconds / 2)
      }

      await this.manager.work(queues.MONITOR_STATES, monitorStatesWorkOptions, (job) => this.onMonitorStates(job))
    }
  }

  metaMonitor () {
    this.metaMonitorInterval = setInterval(async () => {
      try {
        if (this.config.__test__throw_meta_monitor) {
          throw new Error(this.config.__test__throw_meta_monitor)
        }

        const { secondsAgo } = await this.getMaintenanceTime()

        if (secondsAgo > this.maintenanceIntervalSeconds * 2) {
          await this.manager.deleteQueue(queues.MAINTENANCE, { before: states.completed })
          await this.maintenanceAsync()
        }
      } catch (err) {
        this.emit(events.error, err)
      }
    }, this.maintenanceIntervalSeconds * 2 * 1000)
  }

  async maintenanceAsync (options = {}) {
    const { startAfter } = options

    options = {
      startAfter,
      retentionSeconds: this.maintenanceIntervalSeconds * 4,
      singletonKey: queues.MAINTENANCE,
      onComplete: false
    }

    await this.manager.send(queues.MAINTENANCE, null, options)
  }

  async monitorStatesAsync (options = {}) {
    const { startAfter } = options

    options = {
      startAfter,
      retentionSeconds: this.monitorIntervalSeconds * 4,
      singletonKey: queues.MONITOR_STATES,
      onComplete: false
    }

    await this.manager.send(queues.MONITOR_STATES, null, options)
  }

  async onMaintenance (job) {
    try {
      if (this.config.__test__throw_maint) {
        throw new Error(this.config.__test__throw_maint)
      }

      // [optionally] pull maintenance query details from a feature flag
      const flag = await getMaintenanceConfigFromFlag(this.config, (e) => this.emit(events.error, e))
      const started = Date.now()

      await this.expire()
      await this.archive(flag)
      await this.purge()

      const ended = Date.now()

      await this.setMaintenanceTime()

      this.emit('maintenance', { ms: ended - started })

      if (!this.stopped) {
        await this.manager.complete(job.id) // pre-complete to bypass throttling
        // maintenanceInterval = 0 -- Invalid
        // maintenanceInterval < 20 -- likely impractical, but depends on user workload. So we don't enforce a minimum
        const maintenanceInterval = (flag && Number.isFinite(flag.maintenanceInterval) && flag.maintenanceInterval > 0)
          ? flag.maintenanceInterval
          : this.maintenanceIntervalSeconds // lib defaults | client config
        await this.maintenanceAsync({ startAfter: maintenanceInterval })
      }
    } catch (err) {
      this.emit(events.error, err)
    }
  }

  async onMonitorStates (job) {
    try {
      if (this.config.__test__throw_monitor) {
        throw new Error(this.config.__test__throw_monitor)
      }

      const states = await this.countStates()

      this.emit(events.monitorStates, states)

      if (!this.stopped && this.monitorStates) {
        await this.manager.complete(job.id) // pre-complete to bypass throttling
        await this.monitorStatesAsync({ startAfter: this.monitorIntervalSeconds })
      }
    } catch (err) {
      this.emit(events.error, err)
    }
  }

  async stop () {
    if (this.config.__test__throw_stop) {
      throw new Error(this.config.__test__throw_stop)
    }

    if (!this.stopped) {
      if (this.metaMonitorInterval) {
        clearInterval(this.metaMonitorInterval)
      }

      await this.manager.offWork(queues.MAINTENANCE)

      if (this.monitorStates) {
        await this.manager.offWork(queues.MONITOR_STATES)
      }

      this.stopped = true
    }
  }

  async countStates () {
    const stateCountDefault = { ...plans.states }

    Object.keys(stateCountDefault)
      .forEach(key => { stateCountDefault[key] = 0 })

    const counts = await this.executeSql(this.countStatesCommand)

    const states = counts.rows.reduce((acc, item) => {
      if (item.name) {
        acc.queues[item.name] = acc.queues[item.name] || { ...stateCountDefault }
      }

      const queue = item.name ? acc.queues[item.name] : acc
      const state = item.state || 'all'

      // parsing int64 since pg returns it as string
      queue[state] = parseFloat(item.size)

      return acc
    }, { ...stateCountDefault, queues: {} })

    return states
  }

  async expire () {
    await this.executeSql(this.expireCommand)
  }

  async archive (flag = null) {
    let archiveJobAgeLimit = this.config.archiveInterval
    let archiveBatchSize // use default in plans.archive() func
    let statementTimeout // use default in plans.locked() func

    if (flag) {
      if (isSQLInterval(flag.archiveJobAgeLimit)) archiveJobAgeLimit = flag.archiveJobAgeLimit
      if (Number.isInteger(flag.archiveBatchSize) && flag.archiveBatchSize > 0) archiveBatchSize = flag.archiveBatchSize
      if (isSQLInterval(flag.statementTimeout)) statementTimeout = flag.statementTimeout
    }

    const command = plans.locked(
      this.config.schema,
      plans.archive(this.config.schema, archiveJobAgeLimit, archiveBatchSize),
      statementTimeout
    )
    await this.executeSql(command)
  }

  async purge () {
    await this.executeSql(this.purgeCommand)
  }

  async setMaintenanceTime () {
    await this.executeSql(this.setMaintenanceTimeCommand)
  }

  async getMaintenanceTime () {
    if (!this.stopped) {
      const { rows } = await this.db.executeSql(this.getMaintenanceTimeCommand)

      let { maintained_on: maintainedOn, seconds_ago: secondsAgo } = rows[0]

      secondsAgo = secondsAgo !== null ? parseFloat(secondsAgo) : this.maintenanceIntervalSeconds * 10

      return { maintainedOn, secondsAgo }
    }
  }

  getQueueNames () {
    return queues
  }

  async executeSql (sql, params) {
    if (!this.stopped) {
      return await this.db.executeSql(sql, params)
    }
  }
}

module.exports = Boss
module.exports.QUEUES = queues
