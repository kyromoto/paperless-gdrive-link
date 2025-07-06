import crypto from "node:crypto"
import EventEmitter from "node:events"
import { setTimeout } from "node:timers/promises"

import { drive_v3 } from "googleapis"
import { getLogger } from "@logtape/logtape"

import * as env from "./env"
import { getDriveClient } from "./lib"
import { Account, Config, DriveAccount } from "./types"



export interface DriveMonitorEvents {
    started: (channelId: string) => void
    stopped: (channelId: string) => void
}


export class DriveMonitor {

    private readonly logger = getLogger().getChild(["drive-monitor", this.account.name])

    private driveAccount: DriveAccount
    private driveClient: drive_v3.Drive

    private channelId: string | null | undefined = null
    private channelExpirtation: number | null | undefined = null
    private abortController: AbortController | null | undefined = null

    private eventEmitter = new EventEmitter()

    constructor(
        private readonly config: Config,
        private readonly account: Account
    ) {    
        const driveAccount = this.config.drive_accounts.find(drive => drive.id === this.account.props.drive_account_id)

        if (!driveAccount) {
            throw new Error(`Failed to find drive account for ${this.account.name}`)
        }

        this.driveAccount = driveAccount
        this.driveClient = getDriveClient(driveAccount)
        
        this.eventEmitter.on("renew", this.start.bind(this))
    }


    public async start() {

        this.logger.info(`Starting drive monitor...`)

        const now = Date.now()
        const expirationTimestandMS = now + (this.driveAccount.props.channel_expiration_sec * 1000)
        const channelId = crypto.randomUUID()
        
        const channel = await this.driveClient.files.watch({
            fileId: this.account.props.drive_src_folder_id,
            requestBody: {
                id: channelId,
                type: 'webhook',
                address: `${env.WEBHOOK_URL}/webhook`,
                payload: true,
                expiration: expirationTimestandMS.toString()
            }
        })

        if (!channel.data.id) {
            throw new Error('Failed to start channel')
        }

        if (!channel.data.expiration) {
            throw new Error('Failed to start channel')
        }

        this.channelId = channel.data.id
        this.channelExpirtation = Number.parseInt(channel.data.expiration)
        this.abortController = new AbortController()

        setTimeout((this.channelExpirtation! - now) * 0.9, { signal: this.abortController.signal }).then(() => {
            this.eventEmitter.emit("renew")
        })

        this.eventEmitter.emit("started", this.channelId)

    }

    public async stop(channelId?: string) {

        this.logger.info(`${this.account.name}: Stopping drive monitor...`)

        if (this.abortController) {
            this.abortController.abort()
            this.abortController = null
        }

        if (!this.channelId) {
            throw new Error('Channel id not set')
        }

        const cid = channelId || this.channelId
        this.channelId = null

        await this.driveClient.channels.stop({
            requestBody: {
                id: cid
            }
        }).catch(err => {
            this.logger.error(`Failed to stop channel with id ${channelId}: ${err.message}`, { error: err })
        })

        this.eventEmitter.emit("stopped", channelId)

    }

    
    public on<K extends keyof DriveMonitorEvents>(event: K, handler: DriveMonitorEvents[K]) {
        this.eventEmitter.on(event, handler)
    }


    public getChannelId() {
        return this.channelId
    }

}