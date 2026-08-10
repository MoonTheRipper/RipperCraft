// Shared by the logs view (which prints the numbers) and the live poller
// (which uses them). Kept in its own module so the view never has to import
// the poller.
export const LOG_LINE_LIMIT = 500;

export const LOG_POLL_INTERVAL_MS = 3000;
