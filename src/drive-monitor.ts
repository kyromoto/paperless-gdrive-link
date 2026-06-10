import crypto from "node:crypto";
import type { Logger } from "@logtape/logtape";
import type { Queue } from "bullmq";
import type { drive_v3 } from "googleapis";
import { getDriveClient } from "./lib";
import type { Account, Config, DriveAccount } from "./types";

export type RenewChannelJobPayload = { accountId: string };

export class DriveMonitor {
	private driveAccount: DriveAccount;
	private driveClient: drive_v3.Drive;

	private channelId: string | null | undefined = null;
	private channelExpiration: number | null | undefined = null;
	private isStarting = false;

	constructor(
		private readonly logger: Logger,
		private readonly config: Config,
		private readonly account: Account,
		private readonly renewChannelQueue: Queue<RenewChannelJobPayload>,
	) {
		const driveAccount = this.config.drive_accounts.find((drive) => drive.id === this.account.props.drive_account_id);

		if (!driveAccount) {
			throw new Error(`Failed to find drive account for ${this.account.name}`);
		}

		this.driveAccount = driveAccount;
		this.driveClient = getDriveClient(driveAccount);
	}

	public async start() {
		if (this.isStarting) {
			this.logger.warn("start() already in progress, skipping duplicate call");
			return;
		}
		this.isStarting = true;

		this.logger.info(`Starting ...`);

		const now = Date.now();
		const renewOffsetMs = 30 * 1000;
		const channelId = crypto.randomUUID();
		const channelAddress = new URL("/webhook", this.config.server.drive_monitor.webhook_url).href;
		const channleExpiration = now + (this.driveAccount.props.channel_expiration_sec * 1000) + renewOffsetMs;

		this.logger.debug({
			channelId,
			channelAddress,
			channleExpiration,
		});

		try {
			const channel = await this.driveClient.files.watch({
				fileId: this.account.props.drive_src_folder_id,
				requestBody: {
					id: channelId,
					type: "webhook",
					address: channelAddress,
					expiration: channleExpiration.toString(),
					payload: true,
				},
			});

			if (!channel.data.id) {
				throw new Error("Channel start failed: id not set");
			}

			if (!channel.data.expiration) {
				throw new Error("Channel start failed: expiration not set");
			}

			this.logger.info(`Channel started`, { channel });

			this.channelId = channel.data.id;
			this.channelExpiration = Number.parseInt(channel.data.expiration, 10);

			const renewDelayMs = Math.max(0, this.channelExpiration - Date.now() - renewOffsetMs);
			const renewJobId = `renew-channel-${this.account.id}`;

			this.logger.debug(`Scheduling channel renew job with id ${renewJobId} in ${renewDelayMs}ms`);
			this.logger.trace(`Checking for existing channel renew job with id ${renewJobId}`);
			const job = await this.renewChannelQueue.getJob(renewJobId);

			if (job) {
				await job.changeDelay(renewDelayMs);
				this.logger.info(`Channel renew job already exists, updated delay to ${renewDelayMs}ms`);
			} else {
				await this.renewChannelQueue.add(
					"renew-channel",
					{ accountId: this.account.id },
					{ jobId: renewJobId, delay: renewDelayMs },
				);
				this.logger.info(`Channel renew job scheduled: ${renewJobId} in ${renewDelayMs}ms`);
			}

			// await this.renewChannelQueue.remove(renewJobId).catch(err => {
			// 	this.logger.warn("Failed to remove existing renew channel job with id {id}: {msg}", {
			// 		id: renewJobId,
			// 		msg: err.message
			// 	});
			// });
			// await this.renewChannelQueue.add(
			// 	"renew-channel",
			// 	{ accountId: this.account.id },
			// 	{ jobId: renewJobId, delay: renewDelayMs },
			// );

			
		} finally {
			this.isStarting = false;
		}
	}

	public async stop(channelId?: string) {
		this.logger.info(`Stopping ...`);

		if (!this.channelId) {
			throw new Error("Channel id not set");
		}

		const cid = channelId || this.channelId;
		this.channelId = null;

		await this.driveClient.channels
			.stop({
				requestBody: {
					id: cid,
				},
			})
			.catch((err) => {
				this.logger.error(`Failed to stop channel with id ${channelId}: ${err.message}`, { error: err });
			});
	}

	public getChannelId() {
		return this.channelId;
	}
}
