'use strict';

const { getQueues } = require('../queues/message-queue');

async function queueStats(queue) {
  const [waiting, active, delayed, failed, completed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getDelayedCount(),
    queue.getFailedCount(),
    queue.getCompletedCount(),
  ]);

  return { waiting, active, delayed, failed, completed };
}

function createQueueController() {
  return {
    async stats(req, res) {
      try {
        const queues = getQueues();
        const entries = await Promise.all(
          Object.entries(queues).map(async ([name, queue]) => [name, await queueStats(queue)]),
        );
        res.json({ success: true, queues: Object.fromEntries(entries) });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },
  };
}

module.exports = { createQueueController };
