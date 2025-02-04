#!/usr/bin/env node
import arg from 'next/dist/compiled/arg/index.js'
import { existsSync, watchFile } from 'fs'
import { startServer } from '../server/lib/start-server'
import { getPort, printAndExit } from '../server/lib/utils'
import * as Log from '../build/output/log'
import { startedDevelopmentServer } from '../build/output'
import { cliCommand } from '../lib/commands'
import isError from '../lib/is-error'
import { getProjectDir } from '../lib/get-project-dir'
import { CONFIG_FILES } from '../shared/lib/constants'
import path from 'path'
import { loadBindings } from '../build/swc'

const nextDev: cliCommand = (argv) => {
  const validArgs: arg.Spec = {
    // Types
    '--help': Boolean,
    '--port': Number,
    '--hostname': String,
    '--diagnostics': Boolean,

    // Aliases
    '-h': '--help',
    '-p': '--port',
    '-H': '--hostname',
  }
  let args: arg.Result<arg.Spec>
  try {
    args = arg(validArgs, { argv })
  } catch (error) {
    if (isError(error) && error.code === 'ARG_UNKNOWN_OPTION') {
      return printAndExit(error.message, 1)
    }
    throw error
  }
  if (args['--help']) {
    console.log(`
      Description
        Starts the application in development mode (hot-code reloading, error
        reporting, etc.)

      Usage
        $ next dev <dir> -p <port number>

      <dir> represents the directory of the Next.js application.
      If no directory is provided, the current directory will be used.

      Options
        --port, -p      A port number on which to start the application
        --hostname, -H  Hostname on which to start the application (default: 0.0.0.0)
        --help, -h      Displays this message
    `)
    process.exit(0)
  }

  const dir = getProjectDir(args._[0]) // 获取工程目录

  // Check if pages dir exists and warn if not
  if (!existsSync(dir)) {
    printAndExit(`> No such directory exists as the project root: ${dir}`)
  }

  async function preflight() {
    const { getPackageVersion } = await Promise.resolve(
      require('../lib/get-package-version')
    )
    const [sassVersion, nodeSassVersion] = await Promise.all([
      getPackageVersion({ cwd: dir, name: 'sass' }),
      getPackageVersion({ cwd: dir, name: 'node-sass' }),
    ])
    if (sassVersion && nodeSassVersion) {
      Log.warn(
        'Your project has both `sass` and `node-sass` installed as dependencies, but should only use one or the other. ' +
          'Please remove the `node-sass` dependency from your project. ' +
          ' Read more: https://nextjs.org/docs/messages/duplicate-sass'
      )
    }
  }

  const port = getPort(args) // 获取端口号
  // If neither --port nor PORT were specified, it's okay to retry new ports.
  const allowRetry =
    args['--port'] === undefined && process.env.PORT === undefined

  // We do not set a default host value here to prevent breaking
  // some set-ups that rely on listening on other interfaces
  const host = args['--hostname']

  // 开发服务器选项参数
  const devServerOptions = {
    allowRetry,
    dev: true,
    dir,
    hostname: host,
    isNextDevCommand: true, // 是开发命令行
    port,
  }

  if (args['--diagnostics']) {
    Log.warn('running diagnostics...')

    loadBindings().then((bindings: any) => {
      const packagePath = require('next/dist/compiled/find-up').sync(
        'package.json'
      )
      let r = bindings.diagnostics.startDiagnostics({
        ...devServerOptions,
        rootDir: path.dirname(packagePath),
      })
      // Start preflight after server is listening and ignore errors:
      preflight().catch(() => {})
      return r
    })
  } else {
    startServer(devServerOptions) // 开启服务器
      .then(async (app) => {
        const appUrl = `http://${app.hostname}:${app.port}`
        startedDevelopmentServer(appUrl, `${host || '0.0.0.0'}:${app.port}`)
        // Start preflight after server is listening and ignore errors:
        preflight().catch(() => {})
        // Finalize server bootup:
        await app.prepare() // 准备
        // ***
        // 在prepare这个环节进行了尤为重要的一步：使用webpack进行[多编译者]打包，并且是watch的
        // 在next-dev-server.ts中的prepare函数中创建了HotReloader类实例对象
        // 且执行了它的start函数
        // 编译就是在start函数中进行的 - 所以重要的逻辑就在hot-reloader.ts中
        // ***
      })
      .catch((err) => {
        if (err.code === 'EADDRINUSE') {
          let errorMessage = `Port ${port} is already in use.`
          const pkgAppPath = require('next/dist/compiled/find-up').sync(
            'package.json',
            {
              cwd: dir,
            }
          )
          const appPackage = require(pkgAppPath)
          if (appPackage.scripts) {
            const nextScript = Object.entries(appPackage.scripts).find(
              (scriptLine) => scriptLine[1] === 'next'
            )
            if (nextScript) {
              errorMessage += `\nUse \`npm run ${nextScript[0]} -- -p <some other port>\`.`
            }
          }
          console.error(errorMessage)
        } else {
          console.error(err)
        }
        process.nextTick(() => process.exit(1))
      })
  }

  // ['next.config.js', 'next.config.mjs']
  for (const CONFIG_FILE of CONFIG_FILES) {
    // watch配置文件
    watchFile(path.join(dir, CONFIG_FILE), (cur: any, prev: any) => {
      if (cur.size > 0 || prev.size > 0) {
        console.log(
          `\n> Found a change in ${CONFIG_FILE}. Restart the server to see the changes in effect.`
        )
      }
    })
  }
}

export { nextDev }
