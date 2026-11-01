
import {
    claimNotifications,
    markNotificationFailed,
    markNotificationSent,
    recoverAbandonedNotifications,
} from "../services/notificationQueue.js";

import { sendTelegramMessage } from "../services/telegramAdapter.js";

const POLL_INTERVAL_MS = 3000;
const BATCH_SIZE = 5;

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

export function startNotificationWorker() {
    let running = true;
    let loopPromise;

    async function processNotification(notification) {
        try {
            await sendTelegramMessage(
                notification.telegram_chat_id,
                notification.payload
            );

            const markedSent = await markNotificationSent(
                notification.id
            );

            if (!markedSent) {
                console.warn(
                    `Notification ${notification.id} was delivered, but its status was not updated.`
                );
            }
        } catch (error) {
            console.error(
                `Notification ${notification.id} delivery failed:`,
                error.message
            );

            try {
                const result = await markNotificationFailed(
                    notification.id,
                    notification.attempts,
                    notification.max_attempts,
                    error.message
                );

                if (result) {
                    console.log(
                        `Notification ${notification.id}: ${result.status}`
                    );
                }
            } catch (databaseError) {
                console.error(
                    `Could not update failed notification ${notification.id}:`,
                    databaseError.message
                );
            }
        }
    }

    async function run() {
        console.log("Notification worker started.");

        while (running) {
            try {
                const recovered =
                    await recoverAbandonedNotifications();

                if (recovered.length > 0) {
                    console.log(
                        `Recovered ${recovered.length} abandoned notification(s).`
                    );
                }

                const notifications =
                    await claimNotifications(BATCH_SIZE);

                for (const notification of notifications) {
                    await processNotification(notification);
                }
            } catch (error) {
                console.error(
                    "Notification worker error:",
                    error.message
                );
            }

            if (running) {
                await sleep(POLL_INTERVAL_MS);
            }
        }

        console.log("Notification worker stopped.");
    }

    loopPromise = run();

    return async function stopNotificationWorker() {
        if (!running) return;

        running = false;

        // Wait for the current batch to finish.
        await loopPromise;
    };
}