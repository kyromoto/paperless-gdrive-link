import * as log from "../logger.ts"
import { AppConfigRepository } from "../repositories/app-config.repo.ts"
import { ChannelRespository } from "../repositories.ts";

export function startChannelUseCase(configRepo: AppConfigRepository, channels: ChannelRespository) {

    return async (name: string) => {

        const appConfig = await configRepo.getConfig()

        const drive = await configRepo.getDrive(name)

        if (!drive) {
            throw new Error(`No drive found for ${name}`)
        }

        const account = await configRepo.getAccount(name)

        if (!account) {
            throw new Error(`No account found for ${name}`)
        }

        const channelId = crypto.randomUUID()
        const now = Date.now()
    
        const res = await drive.files.watch({
            fileId: account.google_drive.folder_id,
            requestBody: {
                id: channelId,
                type: "web_hook",
                address: appConfig.server.public_url + "/webhook",
                payload: true,
                expiration: now + (appConfig.channel.expirationInSec * 1000)
            }
        })

        channels.set(res.data.id, {
            owner: name,
            kind: res.data.kind,
            expiration: res.data.expiration,
            ressourceId: res.data.resourceId
        })

        const exp = new Date(Number(res.data.expiration))

        log.info("Channel", res.data.id, ":", "created", name, res.data.kind, exp.toISOString())

    }

}