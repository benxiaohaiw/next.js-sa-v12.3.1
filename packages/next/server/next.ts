import type { Options as DevServerOptions } from './dev/next-dev-server'
import type { NodeRequestHandler } from './next-server'
import type { UrlWithParsedQuery } from 'url'

import './node-polyfill-fetch'
import { default as Server } from './next-server'
import * as log from '../build/output/log'
import loadConfig from './config'
import { resolve } from 'path'
import { NON_STANDARD_NODE_ENV } from '../lib/constants'
import { PHASE_DEVELOPMENT_SERVER } from '../shared/lib/constants'
import { PHASE_PRODUCTION_SERVER } from '../shared/lib/constants'
import { IncomingMessage, ServerResponse } from 'http'
import { NextUrlWithParsedQuery } from './request-meta'
import { shouldUseReactRoot } from './utils'

let ServerImpl: typeof Server

const getServerImpl = async () => {
  if (ServerImpl === undefined)
    ServerImpl = (await Promise.resolve(require('./next-server'))).default
  return ServerImpl
}

export type NextServerOptions = Partial<DevServerOptions>

export interface RequestHandler {
  (
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl?: NextUrlWithParsedQuery | undefined
  ): Promise<void>
}

export class NextServer {
  private serverPromise?: Promise<Server>
  private server?: Server
  private reqHandlerPromise?: Promise<NodeRequestHandler>
  private preparedAssetPrefix?: string
  public options: NextServerOptions

  constructor(options: NextServerOptions) {
    this.options = options
  }

  get hostname() {
    return this.options.hostname
  }

  get port() {
    return this.options.port
  }

  getRequestHandler(): RequestHandler {
    // 这个就是返回的请求处理函数
    return async (
      req: IncomingMessage,
      res: ServerResponse,
      parsedUrl?: UrlWithParsedQuery
    ) => {
      const requestHandler = await this.getServerRequestHandler()
      return requestHandler(req, res, parsedUrl) // 做了个中转，交给它处理
    }
  }

  getUpgradeHandler() {
    return async (req: IncomingMessage, socket: any, head: any) => {
      const server = await this.getServer()
      // @ts-expect-error we mark this as protected so it
      // causes an error here
      return server.handleUpgrade.apply(server, [req, socket, head])
    }
  }

  setAssetPrefix(assetPrefix: string) {
    if (this.server) {
      this.server.setAssetPrefix(assetPrefix)
    } else {
      this.preparedAssetPrefix = assetPrefix
    }
  }

  logError(...args: Parameters<Server['logError']>) {
    if (this.server) {
      this.server.logError(...args)
    }
  }

  async render(...args: Parameters<Server['render']>) {
    const server = await this.getServer()
    return server.render(...args)
  }

  async renderToHTML(...args: Parameters<Server['renderToHTML']>) {
    const server = await this.getServer()
    return server.renderToHTML(...args)
  }

  async renderError(...args: Parameters<Server['renderError']>) {
    const server = await this.getServer()
    return server.renderError(...args)
  }

  async renderErrorToHTML(...args: Parameters<Server['renderErrorToHTML']>) {
    const server = await this.getServer()
    return server.renderErrorToHTML(...args)
  }

  async render404(...args: Parameters<Server['render404']>) {
    const server = await this.getServer()
    return server.render404(...args)
  }

  async serveStatic(...args: Parameters<Server['serveStatic']>) {
    const server = await this.getServer()
    return server.serveStatic(...args)
  }

  // prepare函数
  async prepare() {
    const server = await this.getServer()
    return server.prepare() // DevServer类实例对象的prepare函数
  }

  async close() {
    const server = await this.getServer()
    return (server as any).close()
  }

  private async createServer(options: DevServerOptions): Promise<Server> {
    if (options.dev) {
      const DevServer = require('./dev/next-dev-server').default
      // 创建DevServer类实例对象
      return new DevServer(options)
    }
    const ServerImplementation = await getServerImpl()
    return new ServerImplementation(options)
  }

  private async loadConfig() {
    return loadConfig(
      this.options.dev ? PHASE_DEVELOPMENT_SERVER : PHASE_PRODUCTION_SERVER,
      resolve(this.options.dir || '.'),
      this.options.conf
    )
  }

  private async getServer() {
    if (!this.serverPromise) {
      setTimeout(getServerImpl, 10)
      // 首先加载配置
      this.serverPromise = this.loadConfig().then(async (conf) => {
        // 创建一个DevServer类实例对象
        this.server = await this.createServer({
          ...this.options,
          conf,
        })
        if (this.preparedAssetPrefix) {
          this.server.setAssetPrefix(this.preparedAssetPrefix)
        }
        return this.server // 返回这个DevServer类实例对象
      })
    }
    return this.serverPromise
  }

  private async getServerRequestHandler() {
    // Memoize request handler creation
    if (!this.reqHandlerPromise) {
      this.reqHandlerPromise = this.getServer().then((server) =>
        server.getRequestHandler().bind(server)
        // 获取这个创建的DevServer类实例对象的请求处理函数
      )
    }
    return this.reqHandlerPromise
  }
}

// 这个就是start-server.ts中执行的next函数

// This file is used for when users run `require('next')`
function createServer(options: NextServerOptions): NextServer {
  if (options == null) {
    throw new Error(
      'The server has not been instantiated properly. https://nextjs.org/docs/messages/invalid-server-options'
    )
  }

  if (
    !('isNextDevCommand' in options) &&
    process.env.NODE_ENV &&
    !['production', 'development', 'test'].includes(process.env.NODE_ENV)
  ) {
    log.warn(NON_STANDARD_NODE_ENV)
  }

  if (options.dev && typeof options.dev !== 'boolean') {
    console.warn(
      "Warning: 'dev' is not a boolean which could introduce unexpected behavior. https://nextjs.org/docs/messages/invalid-server-options"
    )
  }

  if (shouldUseReactRoot) {
    ;(process.env as any).__NEXT_REACT_ROOT = 'true'
  }

  return new NextServer(options) // 创建一个NextServer类实例对象
}

// Support commonjs `require('next')`
module.exports = createServer
exports = module.exports

// Support `import next from 'next'`
export default createServer
