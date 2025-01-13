import "@std/dotenv/load"

import * as path from "@std/path"

import { Application, Context, Router } from "@oak/oak"

import * as log from "./logger.ts"
import { logWebhook, matchChannelId } from "./api/middleware.ts";
import { stopChannelUseCase } from "./usecases/stop-channel.usecase.ts";
import { downloadedAddedFilesUseCase } from "./usecases/download-added-files.usecase.ts";
import { WebhookController } from "./api/controller.ts";
import { AppConfigRepository } from "./repositories/app-config.repo.ts";
import { startChannelUseCase } from "./usecases/start-channel.usecase.ts";
import { ChannelRespository } from "./repositories.ts";


const CONFIG_FILE = Deno.env.get("CONFIG_FILE")

if (!CONFIG_FILE) {
  throw new Error ("Failed to start application", {
    cause: "Missing CONFIG_FILE environment variable"
  })
}


const configRepo = new AppConfigRepository(CONFIG_FILE)
const channels: ChannelRespository = new Map()
const app = new Application()
const router = new Router()

const startChannel = startChannelUseCase(configRepo, channels)
const stopChannel = stopChannelUseCase(configRepo, channels)
const downloadAddedFiles = downloadedAddedFilesUseCase(configRepo)


log.debug(
  "AppConfig",
  CONFIG_FILE,
  JSON.stringify(await configRepo.getConfig(), null, 2)
)

const appConfig = await configRepo.getConfig()

for (const account of appConfig.accounts) {

  const accountDataPath = path.join(appConfig.server.data_path, account.name)

  await Deno.lstat(accountDataPath).catch(async () => {
    await Deno.mkdir(accountDataPath, { recursive: true })
  })

  await Deno.lstat(path.join(accountDataPath, account.google_drive.credentials_file))

  const drive = await configRepo.getDrive(account.name)

  if (!drive) {
    throw new Error(`No drive found for ${account.name}`)
  }

  const res = await drive.changes.getStartPageToken({})
  const token = res.data.startPageToken

  if (!token) {
    throw new Error(`Failed to get start page token for ${account.name}`)
  }

  await configRepo.setChangeToken(account.name, token)

}


const handleExit = async (cause: string, ec: number) => {

  log.info("Shutdown application.", cause)

  clearInterval(timer)

  let exitCode = ec;

  for (const [id, channel] of channels) {
    await stopChannel(id).catch(err => {
      log.error("Failed to stop channel", id, channel.owner, err)
      exitCode++
    })
  }

  Deno.exit(exitCode)

}


Deno.addSignalListener("SIGINT", async () => {
  await handleExit("SIGINT received", 0)
})

Deno.addSignalListener("SIGTERM", async () => {
  await handleExit("SIGTERM received", 0)
})


const timer = setInterval(async () => {

  const now = Date.now()

  const expChannels = Array.from(channels).filter(([id, channel]) => {
    const a = new Date(Number(channel.expiration))
    const at = a.getTime()
    const bt = now + (60 * 1000)

    return at < bt
  }, 60 * 1000)

  log.info("Channels to renew", expChannels.length)

  for (const [id, channel] of expChannels) {
    await startChannel(channel.owner)
    await stopChannel(id)
    channels.delete(id)
    log.info("Channel", id, ":", "deleted", channel.owner)
  }

}, 60 * 1000)


router.post("/webhook",
  matchChannelId(channels),
  logWebhook(),
  WebhookController({ downloadAddedFiles, appConfig, channels })
)

// router.get("/channels", async (ctx: Context) => {
//   ctx.response.body = Array.from(channels)
// })

// router.get("/config", async (ctx: Context) => {
//   ctx.response.body = appConfig
// })

app.use(router.routes())
app.use(router.allowedMethods())

app.addEventListener("listen", async ({ secure, hostname, port }) => {
  
  log.info(`Listening on http${secure ? "s" : ""}://${hostname}:${port}`)

  for (const account of appConfig.accounts) {
    await startChannel(account.name)
  }
  
})

await app.listen({ port: Number(appConfig.server.port), secure: false })