import * as log from "../logger.ts"
import { AppConfig, getAccount, getGDriveClient } from "../repositories/config.repo.ts"
import { ChannelRespository } from "../repositories/channel.repo.ts";

export function startChannelUseCase(config: AppConfig, channels: ChannelRespository) {

    return async (owner: string) => {

        const account = getAccount(owner, config)

        if (!account) {
            throw new Error(`No account found for ${owner}`)
        }

        const drive = await getGDriveClient(account.name, config)

        if (!drive) {
            throw new Error(`No drive found for ${account.name}`)
        }



        const channelId = crypto.randomUUID()
        const now = Date.now()
    
        const res = await drive.files.watch({
            fileId: account.google_drive.folder_id,
            requestBody: {
                id: channelId,
                type: "web_hook",
                address: config.server.public_url + "/webhook",
                payload: true,
                expiration: now + (config.channel.expirationInSec * 1000)
            }
        })

        channels.set(res.data.id, {
            owner: owner,
            kind: res.data.kind,
            expiration: res.data.expiration,
            ressourceId: res.data.resourceId
        })

        const exp = new Date(Number(res.data.expiration))

        log.info("Channel", res.data.id, ":", "created", owner, res.data.kind, exp.toISOString())

    }

}