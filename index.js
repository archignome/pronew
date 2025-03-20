const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const moment = require('moment');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Store active bot instances, running scripts, and user-specific payloads
const activeBots = new Map();
const runningScripts = new Map();
const userPayloads = new Map();

// Dice game configuration
const DICE_CONFIG = {
    url: "https://api-dice.goatsbot.xyz/dice/action",
    headers: {
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9,fa;q=0.8",
        "authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoiNjc0YmI1ZGE5NGE4ZjI3NmQxMGMyN2E4IiwiaWF0IjoxNzQyMzE4OTc0LCJleHAiOjE3NDI0MDUzNzQsInR5cGUiOiJhY2Nlc3MifQ.hlVoSW1gRfFMTlilkOzTpH9bcyenPBexHvcO67bklzE",
        "content-type": "application/json",
        "origin": "https://dev.goatsbot.xyz",
        "referer": "https://dev.goatsbot.xyz/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    },
    payloads: [
        {
            point_milestone: 99,
            is_upper: false,
            bet_amount: 0.025,
            currency: "ton"
        }
    ]
};

async function writeAnalysis(responseData) {
    const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
    const realBalance = responseData.user.real_balance;
    const isWin = responseData.dice.is_win;

    const analysisText = `[${timestamp}] Balance: ${realBalance.toFixed(2)} | Win: ${isWin}\n`;
    await fs.appendFile("analysiscoco2.txt", analysisText);
}

async function runDiceScript(bot, chatId, scriptId) {
    let requestCounter = 0;
    let isRunning = true;

    runningScripts.set(scriptId, { isRunning });

    try {
        while (isRunning) {
            const payload = userPayloads.get(chatId) || DICE_CONFIG.payloads[0];
            const response = await axios.post(DICE_CONFIG.url, payload, { headers: DICE_CONFIG.headers });
            const responseData = response.data;

            requestCounter++;
            if (requestCounter % 100 === 0) {
                const statusMessage = `Requests sent: ${requestCounter} | Balance: ${responseData.user.real_balance.toFixed(2)} | Win: ${responseData.dice.is_win}`;
                console.log(statusMessage);
                await bot.sendMessage(chatId, statusMessage);
            }

            await fs.appendFile("responsecoco2.txt", JSON.stringify(response.data) + "\n");
            await writeAnalysis(responseData);

            const scriptState = runningScripts.get(scriptId);
            if (!scriptState || !scriptState.isRunning) {
                isRunning = false;
                break;
            }
        }
    } catch (error) {
        console.error("Error in dice script:", error);
        await bot.sendMessage(chatId, `Script stopped due to error: ${error.message}`);
    } finally {
        runningScripts.delete(scriptId);
    }
}

function createBot(token, webhookUrl) {
    const bot = new TelegramBot(token, { webHook: { port: process.env.PORT || 3000 } });
    
    // Set the webhook
    bot.setWebHook(`${webhookUrl}/webhook/${token}`);
    
    return bot;
}

function handleBotCommands(bot, msg, command) {
    const chatId = msg.chat.id;
    const scriptId = `bot_${bot.token}`;

    switch (command) {
        case '/start':
            return bot.sendMessage(chatId, 'Hello! I am your dice game bot. Use /run to start the dice game script.');
        
        case '/run':
            const scriptState = runningScripts.get(scriptId);
            if (scriptState && scriptState.isRunning) {
                return bot.sendMessage(chatId, 'Script is already running!');
            }
            bot.sendMessage(chatId, 'Starting the dice game script...');
            return runDiceScript(bot, chatId, scriptId);
        
        case '/stop':
            const runningState = runningScripts.get(scriptId);
            if (runningState && runningState.isRunning) {
                runningState.isRunning = false;
                return bot.sendMessage(chatId, 'Stopping the dice game script...');
            }
            return bot.sendMessage(chatId, 'No script is currently running.');
        
        default:
            if (command.startsWith('/setpayload ')) {
                try {
                    const payload = JSON.parse(command.slice(11));
                    userPayloads.set(chatId, payload);
                    return bot.sendMessage(chatId, 'Custom payload set successfully!');
                } catch (error) {
                    return bot.sendMessage(chatId, 'Invalid payload format. Please provide a valid JSON object.');
                }
            } else if (command === '/showpayload') {
                const payload = userPayloads.get(chatId) || "Default payload is in use.";
                return bot.sendMessage(chatId, `Current payload: ${JSON.stringify(payload, null, 2)}`);
            } else if (command === '/resetpayload') {
                userPayloads.delete(chatId);
                return bot.sendMessage(chatId, 'Payload has been reset to the default.');
            }
    }
}

async function disconnectBot(token) {
    const bot = activeBots.get(token);
    if (bot) {
        const scriptId = `bot_${token}`;
        const scriptState = runningScripts.get(scriptId);
        if (scriptState && scriptState.isRunning) {
            scriptState.isRunning = false;
        }
        await bot.deleteWebHook();
        activeBots.delete(token);
        return true;
    }
    return false;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Webhook endpoint for each bot
app.post('/webhook/:token', (req, res) => {
    const token = req.params.token;
    const bot = activeBots.get(token);
    
    if (!bot) {
        return res.sendStatus(404);
    }

    const msg = req.body.message;
    if (msg && msg.text) {
        handleBotCommands(bot, msg, msg.text);
    }

    res.sendStatus(200);
});

app.post('/start_bot', async (req, res) => {
    const { bot_token } = req.body;
    if (!bot_token) {
        return res.status(400).json({ error: 'Bot token is required' });
    }

    try {
        if (activeBots.has(bot_token)) {
            await disconnectBot(bot_token);
        }

        // Get the deployment URL from Vercel environment variables
        const webhookUrl = process.env.VERCEL_URL ? 
            `https://${process.env.VERCEL_URL}` : 
            'http://localhost:3000';

        const bot = createBot(bot_token, webhookUrl);
        activeBots.set(bot_token, bot);
        res.json({ message: 'Bot started successfully!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/disconnect_bot', async (req, res) => {
    const { bot_token } = req.body;
    if (!bot_token) {
        return res.status(400).json({ error: 'Bot token is required' });
    }

    try {
        const disconnected = await disconnectBot(bot_token);
        if (disconnected) {
            res.json({ message: 'Bot disconnected successfully!' });
        } else {
            res.status(404).json({ error: 'No active bot found with this token' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});