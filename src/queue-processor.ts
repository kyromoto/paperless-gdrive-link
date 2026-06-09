import type { CollectChangesJobPayload, FileProcessor, ProcessChangesJobPayload, ProcessStep } from "./file-processor";
import type { Config } from "./types";
import type { DriveMonitor, RenewChannelJobPayload } from "./drive-monitor";
import type { Job } from "bullmq";
import type { Logger } from "@logtape/logtape";

export function makeCollectChangesQueueProcessor(
	logger: Logger,
	config: Config,
	processors: Map<string, FileProcessor>,
) {
	return async (job: Job<CollectChangesJobPayload>) => {
		const account = config.accounts.find((account) => account.id === job.data.accountId);

		if (!account) {
			throw new Error(`Failed to find account ${job.data}`);
		}

		const processor = processors.get(account.id);

		if (!processor) {
			throw new Error(`Failed to find processor for account ${account.name}`);
		}

		const files = await processor.getUnprocessedFiles("changes");

		logger.info(`${account.name}: Found ${files.length} changed files`);

		return files;
	};
}

export function makeProcessChangesQueueProcessor(processors: Map<string, FileProcessor>) {
	return async (job: Job<ProcessChangesJobPayload>) => {
		const processor = processors.get(job.data.accountId);

		if (!processor) {
			throw new Error(`Failed to find processor for account ${job.data.accountId}`);
		}

		let step: ProcessStep | undefined = job.data.step;

		while (step !== "moved") {
			switch (step) {
				case undefined: {
					await processor.downloadFileFromDrive(job.data.file);
					step = "downloaded";
					await job.updateData({ ...job.data, step });
					break;
				}
				case "downloaded": {
					await processor.uploadFileToPaperless(job.data.file);
					step = "uploaded";
					await job.updateData({ ...job.data, step });
					break;
				}
				case "uploaded": {
					await processor.moveFile(job.data.file);
					step = "moved";
					await job.updateData({ ...job.data, step });
					break;
				}
				default: {
					throw new Error(`Invalid step ${step}`);
				}
			}
		}
	};
}


export function makeRenewChannelQueueProcessor(monitors: Map<string, DriveMonitor>) {
	return async (job: Job<RenewChannelJobPayload>) => {
		const monitor = monitors.get(job.data.accountId);

		if (!monitor) {
			throw new Error(`No monitor found for accountId ${job.data.accountId}`);
		}

		await monitor.start();
	};
}
