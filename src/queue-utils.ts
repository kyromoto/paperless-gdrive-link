import type { Logger } from "@logtape/logtape";
import type * as bullmq from "bullmq";

export function attachWorkerLogging<T, R = unknown>(
	logger: Logger,
	worker: bullmq.Worker<T, R>,
	queue: bullmq.Queue<T>,
	getLabel: (data: T | undefined) => string,
	onCompleted?: (job: bullmq.Job<T, R>, result: R) => void | Promise<void>,
): void {
	worker.on("active", (job) => {
		logger.getChild([queue.name, job.id ?? "unknown-id"]).info(`${getLabel(job.data)} started`, { job });
	});
	worker.on("completed", (job, result) => {
		if (onCompleted) {
			onCompleted(job, result);
		} else {
			logger.getChild([queue.name, job.id ?? "unknown-id"]).info(`${getLabel(job.data)} completed`, { job, result });
		}
	});
	worker.on("failed", (job, error) => {
		logger
			.getChild([queue.name, job?.id ?? "unknown-id"])
			.error(`${getLabel(job?.data)} failed: ${error.message}`, { job, error });
	});
	queue.on("error", (error) => {
		logger.getChild(queue.name).error(`queue error: ${error.message}`, { error });
	});
}
