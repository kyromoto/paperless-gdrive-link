import type { Logger } from "@logtape/logtape";
import type bullmq from "bullmq";
import type { Request, Response } from "express";
import type { DriveMonitor } from "./drive-monitor";
import type { CollectChangesJobPayload } from "./file-processor";
import type { Config } from "./types";

export const handleWebhook = (
	logger: Logger,
	config: Config,
	queue: bullmq.Queue<CollectChangesJobPayload>,
	monitors: Map<string, DriveMonitor>
) => {
	return async (req: Request, res: Response) => {
		try {
			logger.info("Handling request ...");

			const channelId = req.get("X-Goog-Channel-Id");
			const state = req.get("X-Goog-Resource-State");

			if (!channelId) {
				throw new AcceptableWebhookError(
					`Received webhook without channel id ... ignoring`,
					200,
					"OK",
				);
			}

			if (!state) {
				throw new AcceptableWebhookError(
					`Received webhook without state ... ignoring`,
					200,
					"OK",
				);
			}

			const accountId = Array.from(monitors.entries()).find(
				([_accountId, monitor]) => monitor.getChannelId() === channelId,
			)?.[0];
			const account = config.accounts.find(
				(account) => account.id === accountId,
			);

			if (!account) {
				throw new AcceptableWebhookError(
					`Received webhook for unknown channel id ... ignoring`,
					200,
					"OK",
				);
			}

			if (state.toLowerCase() === "sync") {
				throw new AcceptableWebhookError(
					`${account.name}: Received sync webhook`,
					200,
					"OK",
				);
			}

			await queue.add(
				queue.name,
				{ accountId: account.id },
				{
					jobId: crypto.randomUUID(),
				},
			);

			res.status(200).send("OK");
		} catch (error: unknown) {
			if (error instanceof AcceptableWebhookError) {
				logger.warn(error.message, { headers: req.headers, ...error.props });
				res.status(error.status).send(error.body);
				return;
			}

			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to handle webhook: ${message}`, { error });
			res.status(200).send("OK");
			return;
		}
	};
};

export const handleHealthCheck = () => {
	return async (_req: Request, res: Response) => {
		res.status(200).json({ status: "OK" });
	};
};

class AcceptableWebhookError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly body: string,
		public readonly props: object = {},
	) {
		super(message);
	}
}
