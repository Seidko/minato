import { Dict, Intersect, makeArray, MaybeArray, valueMap } from 'cosmokit'
import { Context, Service, Spread } from 'cordis'
import { Flatten, Indexable, Keys, Row } from './utils.ts'
import { Selection } from './selection.ts'
import { Field, Model } from './model.ts'
import { Driver } from './driver.ts'
import { Eval, Update } from './eval.ts'
import { Query } from './query.ts'

type TableLike<S> = Keys<S> | Selection

type TableType<S, T extends TableLike<S>> =
  | T extends Keys<S> ? S[T]
  : T extends Selection<infer U> ? U
  : never

export namespace Join1 {
  export type Input<S> = readonly Keys<S>[]

  export type Output<S, U extends Input<S>> = Intersect<
    | U extends readonly (infer K extends Keys<S>)[]
    ? { [P in K]: TableType<S, P> }
    : never
  >

  type Parameters<S, U extends Input<S>> =
    | U extends readonly [infer K extends Keys<S>, ...infer R]
    ? [Row<S[K]>, ...Parameters<S, Extract<R, Input<S>>>]
    : []

  export type Predicate<S, U extends Input<S>> = (...args: Parameters<S, U>) => Eval.Expr<boolean>
}

export namespace Join2 {
  export type Input<S> = Dict<TableLike<S>>

  export type Output<S, U extends Input<S>> = {
    [K in keyof U]: TableType<S, U[K]>
  }

  type Parameters<S, U extends Input<S>> = {
    [K in keyof U]: Row<TableType<S, U[K]>>
  }

  export type Predicate<S, U extends Input<S>> = (args: Parameters<S, U>) => Eval.Expr<boolean>
}

const kTransaction = Symbol('transaction')

export class Database<S = any, C extends Context = Context> extends Service<undefined, C> {
  static [Service.provide] = 'model'
  static [Service.immediate] = true

  public tables: { [K in Keys<S>]: Model<S[K]> } = Object.create(null)
  public drivers: Record<keyof any, Driver> = Object.create(null)
  public migrating = false
  private prepareTasks: Dict<Promise<void>> = Object.create(null)
  private migrateTasks: Dict<Promise<void>> = Object.create(null)

  private stashed = new Set<string>()

  async connect<T = undefined>(driver: Driver.Constructor<T>, ...args: Spread<T>) {
    this.ctx.plugin(driver, args[0] as any)
    await this.ctx.start()
  }

  refresh() {
    for (const name in this.tables) {
      this.prepareTasks[name] = this.prepare(name)
    }
  }

  async prepared() {
    await Promise.all(Object.values(this.prepareTasks))
    if (!this.migrating) {
      await Promise.all(Object.values(this.migrateTasks))
    }
  }

  private getDriver(table: any) {
    // const model: Model = this.tables[name]
    // if (model.driver) return this.drivers[model.driver]
    const driver = Object.values(this.drivers)[0]
    if (driver) driver.database = this
    return driver
  }

  private async prepare(name: string) {
    this.stashed.add(name)
    await this.prepareTasks[name]
    await Promise.resolve()
    if (!this.stashed.delete(name)) return
    await this.getDriver(name)?.prepare(name)
  }

  extend<K extends Keys<S>>(name: K, fields: Field.Extension<S[K]>, config: Partial<Model.Config<S[K]>> = {}) {
    let model = this.tables[name]
    if (!model) {
      model = this.tables[name] = new Model(name)
      // model.driver = config.driver
    }
    model.extend(fields, config)
    this.prepareTasks[name] = this.prepare(name)
    ;(this.ctx as Context).emit('model', name)
  }

  migrate<K extends Keys<S>>(name: K, fields: Field.Extension<S[K]>, callback: Model.Migration) {
    this.extend(name, fields, { callback })
  }

  select<T>(table: Selection<T>, query?: Query<T>): Selection<T>
  select<T extends Keys<S>>(table: T, query?: Query<S[T]>): Selection<S[T]>
  select(table: any, query?: any) {
    return new Selection(this.getDriver(table), table, query)
  }

  join<U extends Join1.Input<S>>(tables: U, callback?: Join1.Predicate<S, U>, optional?: boolean[]): Selection<Join1.Output<S, U>>
  join<U extends Join2.Input<S>>(tables: U, callback?: Join2.Predicate<S, U>, optional?: Dict<boolean, Keys<U>>): Selection<Join2.Output<S, U>>
  join(tables: any, query?: any, optional?: any) {
    if (Array.isArray(tables)) {
      const sel = new Selection(this.getDriver(tables[0]), Object.fromEntries(tables.map((name) => [name, this.select(name)])))
      if (typeof query === 'function') {
        sel.args[0].having = Eval.and(query(...tables.map(name => sel.row[name])))
      }
      sel.args[0].optional = Object.fromEntries(tables.map((name, index) => [name, optional?.[index]]))
      return this.select(sel)
    } else {
      const sel = new Selection(this.getDriver(Object.values(tables)[0]), valueMap(tables, (t: TableLike<S>) => typeof t === 'string' ? this.select(t) : t))
      if (typeof query === 'function') {
        sel.args[0].having = Eval.and(query(sel.row))
      }
      sel.args[0].optional = optional
      return this.select(sel)
    }
  }

  async get<T extends Keys<S>, K extends Keys<S[T]>>(table: T, query: Query<S[T]>, cursor?: Driver.Cursor<K>): Promise<Pick<S[T], K>[]> {
    return this.select(table, query).execute(cursor)
  }

  async eval<T extends Keys<S>, U>(table: T, expr: Selection.Callback<S[T], U, true>, query?: Query<S[T]>): Promise<U> {
    return this.select(table, query).execute(typeof expr === 'function' ? expr : () => expr)
  }

  async set<T extends Keys<S>>(table: T, query: Query<S[T]>, update: Row.Computed<S[T], Update<S[T]>>): Promise<Driver.WriteResult> {
    const sel = this.select(table, query)
    if (typeof update === 'function') update = update(sel.row)
    const primary = makeArray(sel.model.primary)
    if (primary.some(key => key in update)) {
      throw new TypeError(`cannot modify primary key`)
    }
    update = sel.model.format(update)
    if (Object.keys(update).length === 0) return {}
    return await sel._action('set', update).execute()
  }

  async remove<T extends Keys<S>>(table: T, query: Query<S[T]>): Promise<Driver.WriteResult> {
    const sel = this.select(table, query)
    return await sel._action('remove').execute()
  }

  async create<T extends Keys<S>>(table: T, data: Partial<S[T]>): Promise<S[T]> {
    const sel = this.select(table)
    const { primary, autoInc } = sel.model
    if (!autoInc) {
      const keys = makeArray(primary)
      if (keys.some(key => !(key in data))) {
        throw new Error('missing primary key')
      }
    }
    return sel._action('create', sel.model.create(data)).execute()
  }

  async upsert<T extends Keys<S>>(
    table: T,
    upsert: Row.Computed<S[T], Update<S[T]>[]>,
    keys?: MaybeArray<Keys<Flatten<S[T]>, Indexable>>,
  ): Promise<Driver.WriteResult> {
    const sel = this.select(table)
    if (typeof upsert === 'function') upsert = upsert(sel.row)
    upsert = upsert.map(item => sel.model.format(item))
    keys = makeArray(keys || sel.model.primary) as any
    return await sel._action('upsert', upsert, keys).execute()
  }

  async withTransaction(callback: (database: Database<S>) => Promise<void>): Promise<void>
  async withTransaction<T extends Keys<S>>(table: T, callback: (database: Database<S>) => Promise<void>): Promise<void>
  async withTransaction(arg: any, ...args: any[]) {
    if (this[kTransaction]) throw new Error('nested transactions are not supported')
    const [table, callback] = typeof arg === 'string' ? [arg, ...args] : [null, arg, ...args]
    const driver = this.getDriver(table)
    return await driver.withTransaction(async (session) => {
      const database = new Proxy(this, {
        get(target, p, receiver) {
          if (p === kTransaction) return true
          else if (p === 'getDriver') return () => session
          else return Reflect.get(target, p, receiver)
        },
      })
      await callback(database)
    })
  }

  async stopAll() {
    const drivers = Object.values(this.drivers)
    this.drivers = Object.create(null)
    await Promise.all(drivers.map(driver => driver.stop()))
  }

  async drop<T extends Keys<S>>(table: T) {
    await this.getDriver(table).drop(table)
  }

  async dropAll() {
    await Promise.all(Object.values(this.drivers).map(driver => driver.dropAll()))
  }

  async stats() {
    await this.prepared()
    const stats: Driver.Stats = { size: 0, tables: {} }
    await Promise.all(Object.values(this.drivers).map(async (driver) => {
      const { size = 0, tables } = await driver.stats()
      stats.size += size
      Object.assign(stats.tables, tables)
    }))
    return stats
  }
}
