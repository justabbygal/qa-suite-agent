const express = require('express');
const { processStory } = require('./agent');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'qa-suite-agent' });
});

// Main webhook endpoint - receives story + tasks from n8n
app.post('/run', async (req, res) => {
  // Verify webhook secret
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const {
    storyId,
    storyTitle,
    projectName,
    tasks,       // Array of { id, title, description }
    context      // Cached initiative context from Notion
  } = req.body;

  if (!storyId || !tasks || !Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: 'Missing storyId or tasks array' });
  }

  console.log(`\n========================================`);
  console.log(`RECEIVED: Story "${storyTitle}" with ${tasks.length} tasks`);
  console.log(`========================================\n`);

  // Respond immediately - processing happens async
  res.json({
    accepted: true,
    storyId,
    taskCount: tasks.length,
    message: 'Processing started'
  });

  // Process in background
  try {
    await processStory({
      storyId,
      storyTitle,
      projectName,
      tasks,
      context
    });
  } catch (error) {
    console.error('Fatal error processing story:', error);
  }
});

app.listen(PORT, () => {
  console.log(`QA Suite Agent running on port ${PORT}`);
  console.log(`Webhook endpoint: POST /run`);

  // Verify required env vars
  const required = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'LINEAR_API_KEY'];
  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.warn(`WARNING: Missing env vars: ${missing.join(', ')}`);
  } else {
    console.log('All required env vars present');
  }
});
