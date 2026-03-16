import type { Logger } from "@logtape/logtape";
import type { Job } from "bullmq";
import type {
	CollectChangesJobPayload,
	FileProcessor,
	ProcessChangesJobPayload,
} from "./file-processor";
import type { Config } from "./types";

export function makeCollectChangesQueueProcessor<T>(
	logger: Logger,
	config: Config,
	processors: Map<string, FileProcessor>,
) {
	return async (job: Job<CollectChangesJobPayload>) => {
		const account = config.accounts.find(
			(account) => account.id === job.data.accountId,
		);

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

export function makeProcessChangesQueueProcessor(
	processors: Map<string, FileProcessor>,
) {
	return async (job: Job<ProcessChangesJobPayload>) => {
		const processor = processors.get(job.data.accountId);

		if (!processor) {
			throw new Error(
				`Failed to find processor for account ${job.data.accountId}`,
			);
		}

		await processor.processFile(job.data.file);
	};
}
