import type { NextServerOptions, NextServer, RequestHandler } from '../next'
import { warn } from '../../build/output/log'
import http from 'http'
import next from '../next'

interface StartServerOptions extends NextServerOptions {
  allowRetry?: boolean
  keepAliveTimeout?: number
}

export function startServer(opts: StartServerOptions) {
  let requestHandler: RequestHandler

  // 创建http服务器
  const server = http.createServer((req, res) => {
    return requestHandler(req, res)
  })

  if (opts.keepAliveTimeout) {
    server.keepAliveTimeout = opts.keepAliveTimeout
  }

  return new Promise<NextServer>((resolve, reject) => {
    let port = opts.port
    let retryCount = 0

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (
        port &&
        opts.allowRetry &&
        err.code === 'EADDRINUSE' &&
        retryCount < 10
      ) {
        warn(`Port ${port} is in use, trying ${port + 1} instead.`)
        port += 1
        retryCount += 1
        server.listen(port, opts.hostname)
      } else {
        reject(err)
      }
    })

    let upgradeHandler: any

    if (!opts.dev) {
      server.on('upgrade', (req, socket, upgrade) => {
        upgradeHandler(req, socket, upgrade)
      })
    }

    server.on('listening', () => {
      const addr = server.address()
      const hostname =
        !opts.hostname || opts.hostname === '0.0.0.0'
          ? 'localhost'
          : opts.hostname

      // 返回的是NextServer类实例对象
      const app = next({
        ...opts,
        hostname,
        customServer: false, // 不是自定义服务器
        httpServer: server, // 创建出的server
        port: addr && typeof addr === 'object' ? addr.port : port, // 端口号
      })

      requestHandler = app.getRequestHandler() // 获取app的请求处理函数
      upgradeHandler = app.getUpgradeHandler()
      resolve(app) // 将app传出去
    })

    server.listen(port, opts.hostname) // 执行http服务器的listen方法
  })
}
