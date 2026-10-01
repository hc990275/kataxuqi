const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_THREAD_ID = process.env.TG_THREAD_ID;

let stats = {
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    failedAccounts: []
};

const RENEW_DATES_FILE = path.join(process.cwd(), 'renew_dates.json');

function loadRenewDates() {
    if (fs.existsSync(RENEW_DATES_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(RENEW_DATES_FILE, 'utf8'));
        } catch (e) {
            console.error('解析 renew_dates.json 错误:', e);
        }
    }
    return {};
}

function saveRenewDates(dates) {
    try {
        fs.writeFileSync(RENEW_DATES_FILE, JSON.stringify(dates, null, 2), 'utf8');
    } catch (e) {
        console.error('保存 renew_dates.json 错误:', e);
    }
}

// --- 辅助函数：转义 Telegram Markdown v1 特殊字符 ---
function escapeMarkdown(text) {
    return text.replace(/([_*`\[])/g, '\\$1');
}

// --- 辅助函数：多格式智能用户提取 (支持 JSON数组、单双引号容错、多行文本、多种环境变量名) ---
function getUsers() {
    const rawUsers = (
        process.env.USERS_JSON || 
        process.env.USERS || 
        process.env.KATA_USERS || 
        process.env.ACCOUNTS || 
        ''
    ).trim();

    // 1. 如果环境变量为空，尝试从本地文件加载
    if (!rawUsers) {
        const localFiles = ['users.json', 'accounts.json', 'accounts.txt', 'users.txt'];
        for (const file of localFiles) {
            const fullPath = path.join(process.cwd(), file);
            if (fs.existsSync(fullPath)) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf8').trim();
                    if (content) {
                        console.log(`[用户配置] 从本地文件 ${file} 读取用户凭据...`);
                        return parseUsersString(content);
                    }
                } catch (e) {}
            }
        }

        // 尝试单账号环境变量
        const singleUser = process.env.KATA_USERNAME || process.env.EMAIL || process.env.USERNAME_LOGIN;
        const singlePass = process.env.KATA_PASSWORD || process.env.PASSWORD || process.env.PASS_LOGIN;
        if (singleUser && singlePass) {
            console.log('[用户配置] 从单账号环境变量读取到 1 个用户');
            return [{
                username: singleUser.trim(),
                password: singlePass.trim(),
                serverId: (process.env.SERVER_ID || '').trim() || undefined
            }];
        }

        console.error('\n❌ [错误] 未能获取到用户配置！');
        console.error('👉 请在 GitHub 仓库 -> Settings -> Secrets and variables -> Actions 中添加 Secret:');
        console.error('   Name:  USERS_JSON');
        console.error('   Value: [{"username": "your_email@example.com", "password": "your_password"}]\n');
        return [];
    }

    return parseUsersString(rawUsers);
}

function parseUsersString(raw) {
    // 尝试 JSON 解析
    try {
        let cleaned = raw;
        // 修复单引号 JSON
        if (cleaned.startsWith("[") && cleaned.includes("'")) {
            cleaned = cleaned.replace(/'/g, '"');
        }
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map(item => ({
                username: (item.username || item.user || item.email || '').trim(),
                password: (item.password || item.pass || '').trim(),
                serverId: item.serverId || item.server_id || undefined
            })).filter(u => u.username && u.password);
        }
    } catch (e) {}

    // 尝试多行文本解析 (支持 user:pass / user----pass / user,pass)
    const lines = raw.split(/\r?\n/);
    const users = [];
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        
        let parts = [];
        if (line.includes('----')) {
            parts = line.split('----');
        } else if (line.includes(':') && !line.startsWith('http')) {
            parts = line.split(':');
        } else if (line.includes(',')) {
            parts = line.split(',');
        }

        if (parts.length >= 2) {
            users.push({
                username: parts[0].trim(),
                password: parts[1].trim(),
                serverId: parts[2] ? parts[2].trim() : undefined
            });
        }
    }
    return users;
}

// --- 辅助函数：解析到期时间 ---
function parseExpiryDate(dateStr) {
    if (!dateStr || dateStr === 'Unknown Date' || dateStr.includes('未知')) return null;
    let nextD;
    // 如果是 YYYY-MM-DD 格式
    if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        nextD = new Date(dateStr);
    } else {
        // 如果是 12 July 格式
        let currentYear = new Date().getFullYear();
        nextD = new Date(`${dateStr} ${currentYear}`);
        if (!isNaN(nextD.getTime())) {
            let diff = Math.ceil((nextD.getTime() - Date.now()) / (1000 * 3600 * 24));
            // 如果日期已经过去超过半年，说明是明年的日期
            if (diff < -180) {
                nextD = new Date(`${dateStr} ${currentYear + 1}`);
            }
        }
    }
    
    if (nextD && !isNaN(nextD.getTime())) {
        return Math.ceil((nextD.getTime() - Date.now()) / (1000 * 3600 * 24));
    }
    return null;
}

// --- 辅助函数：提取服务器页面状态 (到期时间、是否未到期提示、下次开放时间) ---
async function extractServerStatus(page) {
    let bodyText = '';
    try {
        bodyText = await page.innerText('body');
    } catch (e) {
        bodyText = '';
    }

    let actualExpiry = null;
    const expiryMatch = bodyText.match(/Expiry\s*[\n\r]*\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\s+[a-zA-Z]+(?:\s+[0-9]{4})?)/i);
    if (expiryMatch) {
        actualExpiry = expiryMatch[1].trim();
    }

    let isNotTimeToRenew = false;
    let nextAvailableNotice = null;
    if (bodyText.includes("You can't renew your server yet")) {
        isNotTimeToRenew = true;
        const nextMatch = bodyText.match(/as of\s+([^\n\r.]+?)(?:\.|\n|$)/i);
        if (nextMatch) {
            nextAvailableNotice = nextMatch[1].trim();
        }
    }

    return {
        bodyText,
        actualExpiry,
        isNotTimeToRenew,
        nextAvailableNotice
    };
}

// --- 辅助函数：发送 Telegram（图文合并为一条消息） ---
async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        if (imagePath && fs.existsSync(imagePath)) {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('chat_id', TG_CHAT_ID);
            if (TG_THREAD_ID) form.append('message_thread_id', TG_THREAD_ID);
            form.append('photo', fs.createReadStream(imagePath));
            form.append('caption', message);
            form.append('parse_mode', 'Markdown');
            await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, form, {
                headers: form.getHeaders()
            });
            console.log('[Telegram] Photo with caption sent.');
        } else {
            const payload = {
                chat_id: TG_CHAT_ID,
                text: message,
                parse_mode: 'Markdown'
            };
            if (TG_THREAD_ID) payload.message_thread_id = TG_THREAD_ID;
            await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, payload);
            console.log('[Telegram] Message sent.');
        }
    } catch (e) {
        console.error('[Telegram] Failed to send:', e.message);
    }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const RENEW_MAX_ATTEMPTS = 5;
process.env.NO_PROXY = 'localhost,127.0.0.1';

// 统一代理变量（兼容 SUB_URL / PROXY_URL / S5_URL / HTTP_PROXY，单变量智能解析）
const PROXY_SOURCE = (process.env.SUB_URL || process.env.PROXY_URL || process.env.S5_URL || process.env.HTTP_PROXY || '').trim();
let PROXY_CONFIG = null;

// --- 注入脚本：Hook Shadow DOM 获取 Turnstile 坐标 ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: parseInt(new URL(PROXY_CONFIG.server).port, 10),
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }
        await axios.get('https://1.1.1.1', axiosConfig);
        console.log('[代理] 连接成功！');
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

function killExistingChrome() {
    try {
        const { execSync } = require('child_process');
        if (process.platform === 'win32') {
            execSync(`powershell -Command "Get-Process chrome,msedge,chromium -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*${DEBUG_PORT}*' } | Stop-Process -Force"`, { stdio: 'ignore' });
        } else {
            execSync(`pkill -9 -f "remote-debugging-port=${DEBUG_PORT}" || true`, { stdio: 'ignore' });
            execSync(`pkill -9 -f chrome || true`, { stdio: 'ignore' });
        }
    } catch (e) {}
}

function resolveChromeExecutable() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }
    try {
        const pw = require('playwright');
        const pwPath = pw.chromium.executablePath();
        if (pwPath && fs.existsSync(pwPath)) return pwPath;
    } catch (e) {}

    const candidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
    for (const cand of candidates) {
        if (fs.existsSync(cand)) return cand;
    }
    return 'google-chrome';
}

async function launchChrome(maxRetries = 3) {
    const executablePath = resolveChromeExecutable();
    console.log(`[Chrome] 探测到可执行文件路径: ${executablePath}`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`\n[Chrome] 检查 Chrome 运行状态 (尝试 ${attempt}/${maxRetries})...`);
        if (await checkPort(DEBUG_PORT)) {
            console.log('[Chrome] ✅ Chrome 已在端口 ' + DEBUG_PORT + ' 上就绪。');
            return;
        }

        // 尝试启动前清理可能残留的僵尸进程
        if (attempt > 1) {
            console.log('[Chrome] 正在清理之前可能残留的僵尸进程与锁文件...');
            killExistingChrome();
            await new Promise(r => setTimeout(r, 2000));
        }

        const tempBase = process.platform === 'win32' ? (process.env.TEMP || 'C:\\Temp') : '/tmp';
        const userDataDir = path.join(tempBase, `chrome_profile_${Date.now()}_${attempt}`);
        try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (e) {}

        const args = [
            `--remote-debugging-port=${DEBUG_PORT}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-gpu',
            `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            `--user-data-dir=${userDataDir}`,
            '--disable-dev-shm-usage',
            '--remote-allow-origins=*'
        ];

        if (IS_MIHOMO_ENABLED) {
            args.push('--proxy-server=http://127.0.0.1:7890');
            args.push('--proxy-bypass-list=<-loopback>');
        }

        console.log(`[Chrome] 正在派生 Chrome 进程...`);
        const errLogPath = path.join(process.cwd(), 'chrome_err.log');
        const errStream = fs.openSync(errLogPath, 'w');
        const chrome = spawn(executablePath, args, {
            detached: true,
            stdio: ['ignore', 'ignore', errStream]
        });

        chrome.on('error', (err) => {
            console.error(`[Chrome] 派生进程报错 (尝试 ${attempt}):`, err.message);
        });
        chrome.unref();

        console.log('[Chrome] 等待 Chrome 端口响应 (最多 25 秒)...');
        let isReady = false;
        for (let i = 0; i < 25; i++) {
            if (await checkPort(DEBUG_PORT)) {
                isReady = true;
                break;
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        if (isReady) {
            console.log('[Chrome] ✅ Chrome 启动成功并就绪！');
            return;
        }

        console.error(`[Chrome] ⚠️ 第 ${attempt} 次启动超时，端口 ${DEBUG_PORT} 未响应。`);
        try {
            if (fs.existsSync(errLogPath)) {
                const errLog = fs.readFileSync(errLogPath, 'utf8');
                if (errLog.trim()) console.error('[Chrome] 启动错误日志:\n', errLog.trim());
            }
        } catch (e) {}

        if (attempt < maxRetries) {
            console.log('[Chrome] 等待 3 秒后重试启动...');
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    throw new Error(`Chrome 启动失败 (已尝试 ${maxRetries} 次)`);
}

async function configurePageViewport(page) {
    try {
        await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
        console.log(`[视口] 已设置为 ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`);
    } catch (e) {
        console.log('[视口] 设置失败:', e.message);
    }
}

async function saveViewportScreenshot(page, imagePath) {
    await page.screenshot({ path: imagePath, fullPage: true });
}

function maskUsernameForLog(username) {
    const value = String(username || '').trim();
    if (!value) return '(empty)';

    const atIndex = value.indexOf('@');
    if (atIndex <= 1) {
        if (value.length <= 3) return `${value[0] || '*'}**`;
        return `${value.slice(0, 1)}***${value.slice(-1)}`;
    }

    const name = value.slice(0, atIndex);
    const domain = value.slice(atIndex + 1);
    const maskedName = name.length <= 2 ? `${name[0] || '*'}*` : `${name.slice(0, 2)}***`;
    return `${maskedName}@${domain}`;
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            let rawUsers = [];

            if (Array.isArray(parsed)) {
                rawUsers = parsed;
            } else if (parsed && Array.isArray(parsed.users)) {
                rawUsers = parsed.users;
            } else if (parsed && typeof parsed === 'object' && (parsed.username || parsed.password)) {
                rawUsers = [parsed];
            }

            const users = [];
            const seenUsernames = new Set();

            for (const entry of rawUsers) {
                if (!entry || typeof entry !== 'object') {
                    console.log('[用户配置] 跳过无效条目: 非对象。');
                    continue;
                }

                const username = String(entry.username || entry.email || '').trim();
                const password = String(entry.password || '').trim();
                const serverId = String(entry.serverId || '').trim();

                if (!username || !password) {
                    console.log(`[用户配置] 跳过无效条目: username/password 不完整 (${maskUsernameForLog(username)})`);
                    continue;
                }

                const dedupeKey = username.toLowerCase();
                if (seenUsernames.has(dedupeKey)) {
                    console.log(`[用户配置] 跳过重复账号: ${maskUsernameForLog(username)}`);
                    continue;
                }

                seenUsernames.add(dedupeKey);
                users.push({ username, password, serverId });
            }

            console.log(`[用户配置] USERS_JSON 原始条目 ${rawUsers.length}，有效用户 ${users.length}`);
            if (users.length > 0) {
                console.log(`[用户配置] 本次执行账号: ${users.map((user) => maskUsernameForLog(user.username)).join(', ')}`);
            }

            stats.total = users.length;
            return users;
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
}

// --- 核心辅助：通过 CDP 派发鼠标点击事件 ---
async function dispatchCdpClick(page, x, y) {
    const client = await page.context().newCDPSession(page);
    try {
        await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
        });
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100)); // 模拟人手点击延迟
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: x,
            y: y,
            button: 'left',
            clickCount: 1
        });
        console.log(`>> CDP 坐标 (${x.toFixed(2)}, ${y.toFixed(2)}) 点击已发送。`);
        return true;
    } catch (e) {
        console.log('>> CDP 点击失败:', e.message);
        return false;
    } finally {
        await client.detach().catch(() => {});
    }
}

// ==========================================
// ========== 1. TURNSTILE 专区 (登录用) ========
// ==========================================
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('>> 发现 Turnstile 数据。比例:', data);
                await frame.evaluate(() => { window.__turnstile_data = null; }).catch(() => {});
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                return await dispatchCdpClick(page, clickX, clickY);
            }
        } catch (e) { }
    }
    return false;
}

async function checkTurnstileSuccess(page) {
    try {
        const hasResponseToken = await page.locator('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]').evaluateAll(elements => {
            return elements.some(el => el.value && el.value.trim().length > 0);
        });
        if (hasResponseToken) return true;
    } catch (e) { }

    const frames = page.frames();
    for (const f of frames) {
        if (f.url().includes('cloudflare')) {
            try {
                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) return true;
            } catch (e) { }
        }
    }
    return false;
}

async function hasTurnstileFrame(page) {
    try {
        const count = await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').count();
        return count > 0;
    } catch (e) {
        return false;
    }
}

async function solveTurnstileIfPresent(page, stageName = "登录", maxAttempts = 10, waitAfterClick = 5000) {
    console.log(`[${stageName}] 开始检测 Cloudflare Turnstile...`);
    let sawTurnstile = false;
    for (let i = 0; i < maxAttempts; i++) {
        if (await hasTurnstileFrame(page)) sawTurnstile = true;

        if (await checkTurnstileSuccess(page)) {
            console.log(`[${stageName}] ✅ Turnstile 已通过验证。`);
            return true;
        }

        const clicked = await attemptTurnstileCdp(page);
        if (clicked) {
            sawTurnstile = true;
            console.log(`[${stageName}] 已点击 Turnstile，等待验证结果 (${waitAfterClick}ms)...`);
            await page.waitForTimeout(waitAfterClick);

            if (await checkTurnstileSuccess(page)) {
                console.log(`[${stageName}] ✅ Turnstile 验证通过！`);
                return true;
            }
            console.log(`[${stageName}] ⚠️ 点击后验证未通过，继续重试...`);
        }
        if (i < maxAttempts - 1) await page.waitForTimeout(1000);
    }
    if (!sawTurnstile) {
        console.log(`[${stageName}] 未检测到 Turnstile。`);
        return true;
    }
    console.log(`[${stageName}] 检测到 Turnstile，但未能通过验证。`);
    return false;
}


// ==========================================
// ========== 2. ALTCHA 专区 (Renew用) =========
// ==========================================
async function getAltchaStatus(page) {
    try {
        return await page.evaluate(() => {
            const normalize = (value) => {
                if (value == null) return '';
                return String(value).trim();
            };

            const widget = document.querySelector('altcha-widget');
            const altchaInputs = Array.from(document.querySelectorAll('input[name="altcha"], textarea[name="altcha"], input[name*="altcha" i], textarea[name*="altcha" i]'));
            const firstFilledInput = altchaInputs.find((input) => normalize(input.value).length > 0);
            const shadowRoot = widget ? widget.shadowRoot : null;
            const checkbox = shadowRoot ? shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"]') : null;

            const stateProp = normalize(widget ? widget.state : '');
            const stateAttr = normalize(widget ? widget.getAttribute('state') : '');
            const valueProp = normalize(widget ? widget.value : '');
            const valueAttr = normalize(widget ? widget.getAttribute('value') : '');
            const hiddenInputValue = normalize(firstFilledInput ? firstFilledInput.value : '');
            const checkboxChecked = checkbox && typeof checkbox.checked === 'boolean' ? checkbox.checked : null;
            const ariaChecked = normalize(checkbox ? checkbox.getAttribute('aria-checked') : '');
            const busyAttr = normalize(widget ? widget.getAttribute('aria-busy') : '');
            const state = stateProp || stateAttr || '';
            const isSolved = state === 'verified' || valueProp.length > 0 || valueAttr.length > 0 || hiddenInputValue.length > 0;
            const isVerifying = !isSolved && (
                state === 'verifying' ||
                state === 'processing' ||
                state === 'working' ||
                checkboxChecked === true ||
                ariaChecked === 'true' ||
                busyAttr === 'true'
            );

            return {
                exists: !!widget || altchaInputs.length > 0,
                solved: isSolved,
                isVerifying,
                state: state || 'unknown',
                hasShadowRoot: !!shadowRoot,
                checkboxChecked,
                ariaChecked,
                valueLength: Math.max(valueProp.length, valueAttr.length),
                hiddenInputLength: hiddenInputValue.length,
                busy: busyAttr === 'true'
            };
        });
    } catch (e) {
        return {
            exists: false,
            solved: false,
            isVerifying: false,
            state: 'error',
            hasShadowRoot: false,
            checkboxChecked: null,
            ariaChecked: '',
            valueLength: 0,
            hiddenInputLength: 0,
            busy: false
        };
    }
}

function formatAltchaStatus(status) {
    const checkedText = status.checkboxChecked === null ? 'unknown' : String(status.checkboxChecked);
    const ariaChecked = status.ariaChecked || 'n/a';
    return `state=${status.state}, solved=${status.solved}, verifying=${status.isVerifying}, shadow=${status.hasShadowRoot}, checked=${checkedText}, ariaChecked=${ariaChecked}, valueLen=${status.valueLength}, hiddenLen=${status.hiddenInputLength}, busy=${status.busy}`;
}

async function checkAltchaSuccess(page) {
    const status = await getAltchaStatus(page);
    return status.solved;
}

async function attemptAltchaClick(page, currentStatus = null) {
    try {
        const altchaWidget = page.locator('altcha-widget').first();
        if (await altchaWidget.count() > 0) {

            const status = currentStatus || await getAltchaStatus(page);
            if (status.solved) return false;
            if (status.isVerifying) {
                console.log(`>> ALTCHA 正在验证中，跳过重复点击。${formatAltchaStatus(status)}`);
                return false;
            }

            await page.waitForTimeout(500);
            await altchaWidget.scrollIntoViewIfNeeded().catch(() => {});

            let boxInfo = await page.evaluate(() => {
                const widget = document.querySelector('altcha-widget');
                if (!widget) return null;

                const pickClickTarget = (root) => {
                    if (!root) return null;
                    return root.querySelector('input[type="checkbox"], [role="checkbox"], label, button');
                };

                if (widget.shadowRoot) {
                    const target = pickClickTarget(widget.shadowRoot);
                    if (target) {
                        const rect = target.getBoundingClientRect();
                        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: target.tagName };
                    }
                }

                const lightDomTarget = pickClickTarget(widget);
                if (lightDomTarget) {
                    const rect = lightDomTarget.getBoundingClientRect();
                    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: true, tagName: lightDomTarget.tagName };
                }

                const rect = widget.getBoundingClientRect();
                return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, isExact: false, tagName: widget.tagName };
            });

            if (boxInfo && boxInfo.width > 0 && boxInfo.height > 0) {
                let clickX, clickY;
                if (boxInfo.isExact) {
                    clickX = boxInfo.x + boxInfo.width / 2;
                    clickY = boxInfo.y + boxInfo.height / 2;
                    console.log(`>> 发现 ALTCHA 内部点击目标 <${boxInfo.tagName}>，精确计算坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                } else {
                    clickX = boxInfo.x + Math.min(25, Math.max(12, boxInfo.width * 0.15));
                    clickY = boxInfo.y + boxInfo.height / 2;
                    console.log(`>> 未获取内部复选框，使用估算坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                }

                await dispatchCdpClick(page, clickX, clickY);

                await page.evaluate(() => {
                    const widget = document.querySelector('altcha-widget');
                    if (widget && widget.shadowRoot) {
                        const cb = widget.shadowRoot.querySelector('input[type="checkbox"]');
                        if (cb && !cb.checked) {
                            cb.click();
                        }
                    }
                });

                return true;
            } else {
                console.log('>> 找到了 ALTCHA 元素，但获取不到有效大小，跳过点击。');
            }
        }
    } catch (e) {
        console.log('>> 尝试查找 ALTCHA 时出错:', e.message);
    }
    return false;
}

async function solveAltchaIfPresent(page, stageName = "Renew阶段", maxAttempts = 15, waitAfterClick = 8000) {
    console.log(`[${stageName}] 开始检测 ALTCHA Captcha...`);
    let sawAltcha = false;

    const startedAt = Date.now();
    const totalWaitBudget = Math.max(waitAfterClick * maxAttempts, waitAfterClick);
    let clickAttempts = 0;
    let lastStatusText = '';

    while (Date.now() - startedAt < totalWaitBudget) {
        const status = await getAltchaStatus(page);
        if (status.exists) sawAltcha = true;

        const statusText = formatAltchaStatus(status);
        if (status.exists && statusText !== lastStatusText) {
            console.log(`[${stageName}] ALTCHA 状态: ${statusText}`);
            lastStatusText = statusText;
        }

        if (status.solved) {
            console.log(`[${stageName}] ✅ ALTCHA 已通过验证。`);
            return true;
        }

        if (!status.exists) {
            await page.waitForTimeout(1000);
            continue;
        }

        if (status.isVerifying) {
            await page.waitForTimeout(1000);
            continue;
        }

        if (clickAttempts >= maxAttempts) {
            console.log(`[${stageName}] 已达到 ALTCHA 最大点击次数 (${maxAttempts})，继续等待最终结果...`);
            await page.waitForTimeout(1000);
            continue;
        }

        const clicked = await attemptAltchaClick(page, status);
        if (!clicked) {
            await page.waitForTimeout(1000);
            continue;
        }

        clickAttempts += 1;
        console.log(`[${stageName}] 已点击 ALTCHA，等待 PoW 哈希计算完成 (${waitAfterClick}ms)，当前点击 ${clickAttempts}/${maxAttempts}...`);

        const clickStartedAt = Date.now();
        let observedVerification = false;

        while (Date.now() - clickStartedAt < waitAfterClick) {
            await page.waitForTimeout(1000);

            const followupStatus = await getAltchaStatus(page);
            if (followupStatus.exists) sawAltcha = true;

            const followupText = formatAltchaStatus(followupStatus);
            if (followupStatus.exists && followupText !== lastStatusText) {
                console.log(`[${stageName}] ALTCHA 状态: ${followupText}`);
                lastStatusText = followupText;
            }

            if (followupStatus.solved) {
                console.log(`[${stageName}] ✅ ALTCHA 验证通过 (PoW 计算完成)！`);
                return true;
            }

            if (followupStatus.isVerifying) {
                observedVerification = true;
                continue;
            }

            if (!observedVerification && Date.now() - clickStartedAt >= 2500) {
                console.log(`[${stageName}] ⚠️ 点击后未观察到 ALTCHA 进入 verifying 状态，准备重新尝试点击...`);
                break;
            }
        }
    }

    if (!sawAltcha) {
        console.log(`[${stageName}] 弹窗中未检测到 ALTCHA 组件。`);
        return true;
    }

    const finalStatus = await getAltchaStatus(page);
    console.log(`[${stageName}] 检测到 ALTCHA，但在 ${Math.ceil((Date.now() - startedAt) / 1000)} 秒内未能通过验证。最终状态: ${formatAltchaStatus(finalStatus)}`);
    return false;
}

// ==========================================
// ========== 3. Mihomo 代理池专区 ==============
// ==========================================
function downloadMihomoBinary() {
    const { execSync } = require('child_process');
    const mihomoPath = path.join(process.cwd(), 'mihomo');
    if (!fs.existsSync(mihomoPath)) {
        try {
            console.log('[代理池] 正在下载 mihomo-linux-amd64...');
            execSync('curl -L -o mihomo.gz https://github.com/MetaCubeX/mihomo/releases/download/v1.18.9/mihomo-linux-amd64-v1.18.9.gz');
            execSync('gzip -d mihomo.gz');
            execSync('chmod +x mihomo');
            console.log('[代理池] Mihomo 下载并解压完成。');
        } catch (e) {
            console.error('[代理池] 下载 Mihomo 失败:', e.message);
            return false;
        }
    }
    return mihomoPath;
}

// 自动解析 S5 节点文本（支持 Telegram socks、HTTP/HTTPS、标准 Socks5 及 IP:Port）
function parseS5TextToMihomoProxies(rawText) {
    const lines = rawText.split(/\r?\n/);
    const proxies = [];
    let currentLabel = '';
    const seenNames = new Set();

    function getUniqueName(baseName) {
        let name = baseName || `Proxy-${proxies.length + 1}`;
        // 清理 yaml 特殊保留符号
        name = name.replace(/[:\[\]\{\},&*#?|<>=!%@\\]/g, '_').trim();
        let finalName = name;
        let counter = 1;
        while (seenNames.has(finalName)) {
            finalName = `${name}-${counter++}`;
        }
        seenNames.add(finalName);
        return finalName;
    }

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line) continue;

        // 识别标题或编号行作为节点别名（例如 "1. 🇭🇰HK-01" 或 "【🇭🇰 中国香港 HK】"）
        if (/^(\d+[\.、]\s*|【)/.test(line)) {
            currentLabel = line.replace(/^\d+[\.、]\s*/, '').replace(/[【】]/g, '').trim();
            continue;
        }

        // 1. Telegram Socks 格式: https://t.me/socks?server=...&port=...&user=...&pass=...
        if (/^(https?:\/\/t\.me\/socks\?|tg:\/\/socks\?)/i.test(line)) {
            try {
                const urlObj = new URL(line.replace(/^tg:\/\/socks\?/i, 'https://dummy.com/socks?'));
                const server = urlObj.searchParams.get('server');
                const port = parseInt(urlObj.searchParams.get('port'), 10);
                const user = urlObj.searchParams.get('user') || urlObj.searchParams.get('username');
                const pass = urlObj.searchParams.get('pass') || urlObj.searchParams.get('password');

                if (server && port && !isNaN(port)) {
                    const nodeName = getUniqueName(currentLabel || `TG-S5-${server}:${port}`);
                    const proxyNode = {
                        name: nodeName,
                        type: 'socks5',
                        server: server,
                        port: port,
                        udp: true,
                        'skip-cert-verify': true
                    };
                    if (user) proxyNode.username = user;
                    if (pass) proxyNode.password = pass;
                    proxies.push(proxyNode);
                    currentLabel = '';
                    continue;
                }
            } catch (e) {}
        }

        // 2. 标准 socks5:// 协议格式: socks5://user:pass@server:port
        if (/^socks5?:\/\//i.test(line)) {
            try {
                const urlObj = new URL(line);
                const server = urlObj.hostname;
                const port = parseInt(urlObj.port, 10) || 1080;
                const user = urlObj.username ? decodeURIComponent(urlObj.username) : undefined;
                const pass = urlObj.password ? decodeURIComponent(urlObj.password) : undefined;
                if (server && port) {
                    const nodeName = getUniqueName(currentLabel || `S5-${server}:${port}`);
                    const proxyNode = {
                        name: nodeName,
                        type: 'socks5',
                        server: server,
                        port: port,
                        udp: true,
                        'skip-cert-verify': true
                    };
                    if (user) proxyNode.username = user;
                    if (pass) proxyNode.password = pass;
                    proxies.push(proxyNode);
                    currentLabel = '';
                    continue;
                }
            } catch (e) {}
        }

        // 3. HTTP 格式 (支持附带 | 备注): http://114.37.235.105:443 | 家宽直连
        if (/^https?:\/\//i.test(line)) {
            try {
                let remark = '';
                if (line.includes('|')) {
                    const parts = line.split('|');
                    line = parts[0].trim();
                    remark = parts[1].trim();
                }
                const urlObj = new URL(line);
                const server = urlObj.hostname;
                const port = parseInt(urlObj.port, 10) || (urlObj.protocol === 'https:' ? 443 : 80);
                const user = urlObj.username ? decodeURIComponent(urlObj.username) : undefined;
                const pass = urlObj.password ? decodeURIComponent(urlObj.password) : undefined;
                if (server && port) {
                    let label = currentLabel;
                    if (remark) label = label ? `${label}-${remark}` : remark;
                    const nodeName = getUniqueName(label || `HTTP-${server}:${port}`);
                    const proxyNode = {
                        name: nodeName,
                        type: 'http',
                        server: server,
                        port: port,
                        tls: urlObj.protocol === 'https:',
                        'skip-cert-verify': true
                    };
                    if (user) proxyNode.username = user;
                    if (pass) proxyNode.password = pass;
                    proxies.push(proxyNode);
                    currentLabel = '';
                    continue;
                }
            } catch (e) {}
        }

        // 4. IP:Port:User:Pass 或 IP:Port 纯文本格式
        const ipportMatch = line.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)(?::([^:]+):([^:]+))?/);
        if (ipportMatch) {
            const server = ipportMatch[1];
            const port = parseInt(ipportMatch[2], 10);
            const user = ipportMatch[3];
            const pass = ipportMatch[4];
            const nodeName = getUniqueName(currentLabel || `S5-${server}:${port}`);
            const proxyNode = {
                name: nodeName,
                type: 'socks5',
                server: server,
                port: port,
                udp: true,
                'skip-cert-verify': true
            };
            if (user) proxyNode.username = user;
            if (pass) proxyNode.password = pass;
            proxies.push(proxyNode);
            currentLabel = '';
            continue;
        }
    }
    return proxies;
}

function startMihomoProcess(mihomoPath) {
    const { execSync, spawn } = require('child_process');
    console.log('[代理池] 正在验证 Mihomo 二进制文件...');
    try {
        const versionOutput = execSync(`${mihomoPath} -v`).toString();
        console.log('[代理池] Mihomo 版本信息:\n', versionOutput.trim());
    } catch (e) {
        console.error('[代理池] Mihomo 二进制文件无法执行:', e.message);
    }

    console.log('[代理池] 正在测试 config.yaml 语法...');
    try {
        const testOutput = execSync(`${mihomoPath} -d ${process.cwd()} -f config.yaml -t`).toString();
        console.log('[代理池] config.yaml 测试结果:\n', testOutput.trim());
    } catch (e) {
        console.error('[代理池] config.yaml 语法错误:', e.message);
        if (e.stdout) console.error(e.stdout.toString());
        if (e.stderr) console.error(e.stderr.toString());
        return false;
    }

    const mihomoProc = spawn(mihomoPath, ['-d', process.cwd(), '-f', 'config.yaml'], {
        detached: true
    });
    mihomoProc.stdout.on('data', data => fs.appendFileSync('mihomo.log', data));
    mihomoProc.stderr.on('data', data => fs.appendFileSync('mihomo.log', data));
    mihomoProc.on('error', err => {
        fs.appendFileSync('mihomo.log', `[SPAWN ERROR] ${err.message}\n`);
    });
    mihomoProc.on('exit', (code, signal) => {
        fs.appendFileSync('mihomo.log', `[EXIT] code=${code} signal=${signal}\n`);
    });
    mihomoProc.unref();
    console.log('[代理池] 正在启动 Mihomo 代理引擎 (5秒)...');
    return true;
}

// 智能代理统一解析与部署核心（自动嗅探 Clash YAML订阅、Base64节点、TG Socks、HTTP、S5文本）
async function setupSmartProxyPool(proxySource) {
    if (!proxySource) return { pool: [], stats: { total: 0, healthy: 0, invalid: 0, source: 'NONE', invalidNodes: [] } };

    const mihomoPath = downloadMihomoBinary();
    if (!mihomoPath) return { pool: [], stats: { total: 0, healthy: 0, invalid: 0, source: 'ERROR', invalidNodes: [] } };

    const isUrl = /^https?:\/\//i.test(proxySource);
    let rawContent = '';
    let isClashYaml = false;

    console.log(`\n[智能代理] 🔍 正在嗅探代理源 (类型: ${isUrl ? '远程链接' : '内联文本'})...`);

    if (isUrl) {
        try {
            console.log(`[智能代理] 正在探测远程地址: ${proxySource} ...`);
            const res = await axios.get(proxySource, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'clash-meta/1.18.9 Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            rawContent = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
            console.log(`[智能代理] 成功获取远程内容，长度: ${rawContent.length} 字符`);

            // 嗅探1：是否为 Clash YAML 订阅内容
            if (rawContent.includes('proxies:') || rawContent.includes('proxy-providers:') || (rawContent.includes('port:') && rawContent.includes('rules:'))) {
                isClashYaml = true;
            }
        } catch (e) {
            console.error(`[智能代理] 探测远程地址提示: ${e.message}，将尝试以订阅 Provider 模式运行...`);
            isClashYaml = true;
        }
    } else {
        rawContent = proxySource;
    }

    // 1. 如果是标准的 Clash 订阅链接或现成 YAML 结构
    if (isClashYaml && isUrl) {
        console.log('[智能代理] 识别为 Clash/Mihomo 标准订阅链接，正在通过 Provider 模式构建...');
        const configYaml = `mixed-port: 7890
allow-lan: false
mode: rule
log-level: debug
external-controller: 127.0.0.1:9090
proxy-providers:
  sub1:
    type: http
    url: "${proxySource}"
    interval: 3600
    path: ./sub1.yaml
    headers:
      User-Agent: ["clash-meta/1.18.9 Mozilla/5.0"]
    health-check:
      enable: true
      interval: 600
      url: http://www.gstatic.com/generate_204

proxy-groups:
  - name: MyGroup
    type: select
    use:
      - sub1
rules:
  - MATCH,MyGroup
`;
        fs.writeFileSync('config.yaml', configYaml, 'utf8');
        const started = startMihomoProcess(mihomoPath);
        if (started) {
            IS_MIHOMO_ENABLED = true;
            await new Promise(r => setTimeout(r, 5000));
            console.log('[智能代理] 正在刷新 provider 节点...');
            await axios.put('http://127.0.0.1:9090/providers/proxies/sub1').catch(()=>{});
            await new Promise(r => setTimeout(r, 2000));
            const proxies = await getMihomoProxies();
            if (proxies.length > 0) {
                const testRes = await testMihomoProxies(proxies);
                return {
                    pool: testRes.healthy,
                    stats: {
                        total: proxies.length,
                        healthy: testRes.healthy.length,
                        invalid: testRes.invalid.length,
                        source: '订阅链接',
                        invalidNodes: testRes.invalid
                    }
                };
            }
        }
    }

    // 2. 尝试从文本/Base64/Telegram S5 中智能提取节点
    let parsedProxies = [];
    if (rawContent) {
        let textToParse = rawContent;
        try {
            const decoded = Buffer.from(rawContent.trim(), 'base64').toString('utf8');
            if (decoded && (decoded.includes('://') || decoded.includes('server='))) {
                textToParse = decoded;
            }
        } catch (e) {}

        parsedProxies = parseS5TextToMihomoProxies(textToParse);
    }

    // 3. 如果提取到了节点列表
    if (parsedProxies.length > 0) {
        console.log(`[智能代理] 成功解析并提取出 ${parsedProxies.length} 个代理节点 (含 TG Socks / HTTP / Socks5)...`);
        let yaml = `mixed-port: 7890
allow-lan: false
mode: rule
log-level: debug
external-controller: 127.0.0.1:9090

proxies:
`;
        for (const p of parsedProxies) {
            yaml += `  - name: "${p.name}"\n`;
            yaml += `    type: ${p.type}\n`;
            yaml += `    server: "${p.server}"\n`;
            yaml += `    port: ${p.port}\n`;
            if (p.username) yaml += `    username: "${p.username}"\n`;
            if (p.password) yaml += `    password: "${p.password}"\n`;
            if (p.tls) yaml += `    tls: true\n`;
            if (p.udp) yaml += `    udp: true\n`;
            yaml += `    skip-cert-verify: true\n`;
        }

        yaml += `\nproxy-groups:\n  - name: MyGroup\n    type: select\n    proxies:\n`;
        for (const p of parsedProxies) {
            yaml += `      - "${p.name}"\n`;
        }
        yaml += `\nrules:\n  - MATCH,MyGroup\n`;

        fs.writeFileSync('config.yaml', yaml, 'utf8');
        const started = startMihomoProcess(mihomoPath);
        if (started) {
            IS_MIHOMO_ENABLED = true;
            await new Promise(r => setTimeout(r, 5000));
            const proxies = await getMihomoProxies();
            if (proxies.length > 0) {
                const testRes = await testMihomoProxies(proxies);
                return {
                    pool: testRes.healthy,
                    stats: {
                        total: proxies.length,
                        healthy: testRes.healthy.length,
                        invalid: testRes.invalid.length,
                        source: '节点池 (S5/HTTP)',
                        invalidNodes: testRes.invalid
                    }
                };
            }
        }
    }

    console.warn('[智能代理] ⚠️ 未能识别出代理节点，将直接使用默认网络。');
    return { pool: [], stats: { total: 0, healthy: 0, invalid: 0, source: 'NONE', invalidNodes: [] } };
}

async function getMihomoProxies() {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await axios.get('http://127.0.0.1:9090/proxies/MyGroup');
            const all = res.data.all || [];
            const filtered = all.filter(name => name !== 'DIRECT' && name !== 'REJECT' && name !== 'MyGroup');
            
            if (filtered.length > 0) {
                return filtered;
            }
            
            console.log(`[代理池] 尝试 ${attempt}: 节点数为0，等待 3 秒后重试...`);
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) {
            console.error(`[代理池] 获取代理列表失败 (尝试 ${attempt}):`, e.message);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    
    console.error('[代理池] 警告：多次尝试后提取到的节点数依然为0！');
    if (fs.existsSync(path.join(process.cwd(), 'sub1.yaml'))) {
        try {
            const subContent = fs.readFileSync(path.join(process.cwd(), 'sub1.yaml'), 'utf8');
            console.error('[代理池] sub1.yaml 下载内容前 500 字符:\n', subContent.substring(0, 500));
        } catch(e) {}
    }
    
    try {
        const logContent = fs.readFileSync(path.join(process.cwd(), 'mihomo.log'), 'utf8');
        console.error('[代理池] Mihomo 运行日志:\n', logContent);
    } catch (err) {}
    
    return [];
}

async function testMihomoProxies(proxyNames) {
    console.log(`\n[代理池] 🔍 开始对 ${proxyNames.length} 个节点进行全面健康检查与测速...`);
    const healthyWithDelay = [];
    const invalidNodes = [];
    const BATCH = 15;
    for (let i = 0; i < proxyNames.length; i += BATCH) {
        const batch = proxyNames.slice(i, i + BATCH);
        const promises = batch.map(async name => {
            try {
                const res = await axios.get(`http://127.0.0.1:9090/proxies/${encodeURIComponent(name)}/delay?timeout=3500&url=http://www.gstatic.com/generate_204`, { timeout: 4500 });
                if (res.data && typeof res.data.delay === 'number') {
                    console.log(`   ├─ ✅ [健康可用] ${name.padEnd(25, ' ')} 延迟: ${res.data.delay}ms`);
                    return { name, delay: res.data.delay };
                }
            } catch (e) {}
            console.log(`   ├─ ❌ [连接超时/失效] ${name}`);
            invalidNodes.push(name);
            return null;
        });
        const results = await Promise.all(promises);
        for (const r of results) {
            if (r) healthyWithDelay.push(r);
        }
    }
    // 按延迟升序排序，优先使用速度更优的节点
    healthyWithDelay.sort((a, b) => a.delay - b.delay);
    const healthy = healthyWithDelay.map(item => item.name);
    console.log(`[代理池] 🏁 测速检查完成: 总计 ${proxyNames.length} 个, 存活有效 ${healthy.length} 个, 失效 ${invalidNodes.length} 个\n`);
    return { healthy, invalid: invalidNodes };
}

async function switchMihomoProxy(name) {
    try {
        await axios.put('http://127.0.0.1:9090/proxies/MyGroup', { name }, { timeout: 2000 });
        console.log(`[代理池] 🚀 成功切换节点: ${name}`);
        return true;
    } catch (e) {
        console.error(`[代理池] ❌ 切换节点 ${name} 失败:`, e.message);
        return false;
    }
}

// ==========================================
// =============== 主循环执行 =================
// ==========================================
(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    const renewDates = loadRenewDates();
    let accountDatesInfo = {};

    let proxyPool = [];
    let proxyIndex = 0;
    let proxyStats = { total: 0, healthy: 0, invalid: 0, source: 'NONE', invalidNodes: [] };

    // 单变量智能代理初始化（传入 PROXY_SOURCE 即可自动识别）
    if (PROXY_SOURCE) {
        const smartResult = await setupSmartProxyPool(PROXY_SOURCE);
        proxyPool = smartResult.pool;
        proxyStats = smartResult.stats;
    }

    if (proxyStats.source !== 'NONE') {
        if (proxyPool.length === 0) {
            console.log('[代理池] ⚠️ 警告：健康检查后未发现可用节点，将降级使用默认网络。');
        } else {
            console.log(`[代理池] 🚀 健康节点池已建立 (共 ${proxyPool.length} 个有效节点)，每个账号及其重试将依次轮换使用不同有效节点！\n`);
        }
    }

    if (proxyStats.source !== 'NONE') {
        if (proxyPool.length === 0) {
            console.log('[代理池] ⚠️ 警告：健康检查后未发现可用节点，将降级使用默认网络。');
        } else {
            console.log(`[代理池] 🚀 健康节点池已建立 (共 ${proxyPool.length} 个有效节点)，每个账号及其重试将依次轮换使用不同有效节点！\n`);
        }
    }

    let browser = null;
    for (let cdpAttempt = 1; cdpAttempt <= 3; cdpAttempt++) {
        try {
            await launchChrome(3);
            console.log(`[CDP] 正在连接 Chrome 调试端口 (尝试 ${cdpAttempt}/3)...`);
            for (let k = 0; k < 6; k++) {
                try {
                    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
                    console.log('[CDP] ✅ 浏览器 CDP 接口连接成功！');
                    break;
                } catch (e) {
                    console.log(`[CDP] 连接尝试 ${k + 1}/6 失败: ${e.message}。2秒后重试...`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            if (browser) break;
        } catch (e) {
            console.error(`[CDP] 第 ${cdpAttempt} 轮启动/连接 Chrome 失败:`, e.message);
        }

        if (!browser && cdpAttempt < 3) {
            console.log('[CDP] 正在清理异常 Chrome 实例并准备重新拉起...');
            killExistingChrome();
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    if (!browser) {
        console.error('[CDP] ❌ 最终无法连接 Chrome，退出执行。');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    if (!context) {
        console.error('无法获取浏览器上下文，退出。');
        await browser.close();
        process.exit(1);
    }

    // --- 代理认证处理 ---
    if (PROXY_CONFIG && PROXY_CONFIG.username && !SUB_URL) {
        console.log('[代理] 设置认证拦截...');
        await context.route('**/*', (route) => {
            route.continue({
                headers: {
                    ...route.request().headers(),
                    'Proxy-Authorization': 'Basic ' + Buffer.from(`${PROXY_CONFIG.username}:${PROXY_CONFIG.password}`).toString('base64')
                }
            });
        });
    }

    // Create a dummy page to keep Chrome alive when other pages are closed
    const dummyPage = await context.newPage();
    for (const p of context.pages()) {
        if (p !== dummyPage) {
            await p.close().catch(()=>{});
        }
    }

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);
        
        const dedupeKey = user.username.toLowerCase();
        // 【改造】移除最外层本地缓存盲跳逻辑：
        // 必须每个账号都真实登录并进入服务器详情页，亲眼读取页面上真实的 Expiry 日期！
        // 并在页面上对比校准本地记录，杜绝因本地假数据导致漏签漏查。

        let accountSuccess = false;
        let accountFailureReason = "未知错误";
        const maxAttempts = (proxyPool.length > 1) ? 5 : 3;
        let page = null;
        let usedNode = 'DIRECT';
        
        for (let accountAttempt = 1; accountAttempt <= maxAttempts; accountAttempt++) {
            if (proxyPool.length > 0) {
                const nodeName = proxyPool[proxyIndex % proxyPool.length];
                usedNode = nodeName;
                proxyIndex++;
                console.log(`\n[节点轮换] 账号 ${maskUsernameForLog(user.username)} ${accountAttempt > 1 ? `第 ${accountAttempt} 次重试` : '新账号接入'}: 🚀 分配有效节点 -> [${nodeName}] (节点池轮换序列: #${proxyIndex})`);
                await switchMihomoProxy(nodeName);
                await new Promise(r => setTimeout(r, 1000));
            }

            if (accountAttempt > 1) {
                console.log(`[重试] 账号 ${maskUsernameForLog(user.username)} 开始第 ${accountAttempt}/${maxAttempts} 次执行流程...`);
            }

            try {
                if (page && !page.isClosed()) {
                    await page.close().catch(()=>{});
                }
                await context.clearCookies();
                page = await context.newPage();
                page.setDefaultTimeout(60000);
                await configurePageViewport(page);
                await page.addInitScript(INJECTED_SCRIPT);

                console.log('正在访问登录页...');
                await page.goto('https://dashboard.katabump.com/auth/login');
                await page.waitForTimeout(2000);
                
                const loginTurnstileOk = await solveTurnstileIfPresent(page, "登录阶段", 10, 5000);
                if (!loginTurnstileOk) {
                    console.log('   >> 登录阶段 Turnstile 验证失败，切换节点重试');
                    accountFailureReason = "登录阶段防火墙拦截";
                    continue; // 触发节点重试
                }

                console.log('正在输入凭据...');
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                
                await page.waitForTimeout(500);
                await page.getByRole('button', { name: 'Login', exact: true }).click();

                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ 登录失败: 账号或密码错误`);
                        const failPhotoDir = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(failPhotoDir)) fs.mkdirSync(failPhotoDir, { recursive: true });
                        const failSafe = user.username.replace(/[^a-z0-9]/gi, '_');
                        const failScreenshot = path.join(failPhotoDir, `${failSafe}_login_fail.png`);
                        try { await saveViewportScreenshot(page, failScreenshot); } catch (e) {}
                        await sendTelegramMessage(`❌ *[@s5gydl] ${escapeMarkdown(user.username)}*\n登录失败: 账号或密码错误`, failScreenshot);
                        stats.failed++;
                        stats.failedAccounts.push(user.username);
                        accountDatesInfo[user.username] = {
                            status: "❌ 登录失败",
                            nextDate: "未知",
                            daysLeft: "未知",
                            node: usedNode
                        };
                        accountSuccess = true; // Set true to break out of outer loop since password is wrong
                        break;
                    }
                } catch (e) { }

                if (user.serverId) {
                    console.log(`正在通过 Server ID (${user.serverId}) 直接访问续期页面...`);
                    await page.goto(`https://dashboard.katabump.com/servers/edit?id=${user.serverId}`);
                    await page.waitForTimeout(3000);
                } else {
                    console.log('未配置 Server ID，正在寻找 "See" 链接...');
                    try {
                        await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                        await page.waitForTimeout(1000);
                        await page.getByRole('link', { name: 'See' }).first().click();
                        await page.waitForTimeout(3000);
                    } catch (e) {
                        console.log('未找到 "See" 按钮 (可能登录未成功或网络断开)。');
                        accountFailureReason = "找不到 See 按钮，可能节点被阻断";
                        continue;
                    }
                }

                const photoDir = path.join(process.cwd(), 'screenshots');
                if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');

                // --- 1. 读取页面当前实际状态 (到期时间与未到期提示) ---
                console.log('正在读取服务器页面到期时间与状态...');
                let serverStatus = await extractServerStatus(page);
                let pageActualExpiry = serverStatus.actualExpiry;

                if (pageActualExpiry) {
                    console.log(`[日期检查] 页面当前实际到期时间: ${pageActualExpiry}`);
                    // 如果本地记录与页面不一致，重新写入本地文件
                    if (renewDates[dedupeKey] !== pageActualExpiry) {
                        console.log(`[日期矫正] 账号 ${user.username}: 本地记录 (${renewDates[dedupeKey] || '空'}) 与页面实际 (${pageActualExpiry}) 不一致，重新写入本地文件！`);
                        renewDates[dedupeKey] = pageActualExpiry;
                        saveRenewDates(renewDates);
                    } else {
                        saveRenewDates(renewDates);
                    }
                }

                let renewPhaseSuccess = false;

                // --- 2. 检查页面是否已直接提示未到期 (You can't renew your server yet) ---
                if (serverStatus.isNotTimeToRenew) {
                    let daysLeft = parseExpiryDate(pageActualExpiry) || '未知';
                    console.log(`[未到期提示] 页面已明确提示未到续期时间。下次可续期: ${serverStatus.nextAvailableNotice || '未知'}`);
                    
                    const statusScreenshot = path.join(photoDir, `${safeUsername}_status.png`);
                    try { await saveViewportScreenshot(page, statusScreenshot); } catch (e) {}

                    let nextNoticeText = serverStatus.nextAvailableNotice ? `\n⏳ 下次可续期: \`${serverStatus.nextAvailableNotice}\`` : '';
                    await sendTelegramMessage(
                        `🔄 *[@s5gydl] ${escapeMarkdown(user.username)}*\n校正日期成功 (未到续期时间)\n📅 实际有效期: \`${pageActualExpiry || '已校正'}\` (还剩 ${daysLeft} 天)${nextNoticeText}`,
                        statusScreenshot
                    );

                    stats.skipped++;
                    accountDatesInfo[user.username] = {
                        status: "🔄 校正成功(未到期)",
                        nextDate: pageActualExpiry || '已校正',
                        daysLeft: daysLeft,
                        node: usedNode
                    };
                    renewPhaseSuccess = true;
                    accountSuccess = true;
                    break;
                }

                // --- 3. 页面未显示不可续期警告，进入 Renew 按钮与弹窗处理 ---
                for (let attempt = 1; attempt <= RENEW_MAX_ATTEMPTS; attempt++) {
                    if (page.url().includes('login')) {
                        console.log('页面被重定向到登录页，退出 Renew 循环。');
                        break;
                    }

                    console.log(`\n[尝试 ${attempt}/${RENEW_MAX_ATTEMPTS}] 正在寻找 Renew 按钮...`);
                    const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                    
                    try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { }

                    if (await renewBtn.isVisible()) {
                        await renewBtn.click();
                        console.log('Renew 按钮已点击。等待模态框...');

                        const modal = page.locator('.modal-content, [role="dialog"], div:has-text("This will extend the life of your server.")').filter({ hasText: 'Renew' }).last();
                        try { await modal.waitFor({ state: 'visible', timeout: 8000 }); } catch (e) {
                            console.log('模态框未出现？重试中...');
                            continue;
                        }

                        try {
                            const box = await modal.boundingBox();
                            if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                        } catch (e) { }

                        let confirmBtn = modal.getByRole('button', { name: 'Renew', exact: true });
                        if (!(await confirmBtn.isVisible().catch(() => false))) {
                            confirmBtn = modal.locator('button:has-text("Renew")').last();
                        }
                        if (await confirmBtn.isVisible()) {
                            
                            const captchaScreenshotName = `${safeUsername}_modal_${attempt}.png`;
                            try {
                                await saveViewportScreenshot(page, path.join(photoDir, captchaScreenshotName));
                                console.log(`   >> 弹窗截图已保存: ${captchaScreenshotName}`);
                            } catch (e) { }

                            console.log('   >> 点击弹窗中的 Renew 确认按钮...');
                            await confirmBtn.click({ force: true }).catch(() => confirmBtn.click());

                            // 等待服务端处理及页面响应
                            console.log('   >> 等待页面反馈...');
                            await page.waitForTimeout(2500);

                            // 点击后立即检查页面状态 (包括主页面及弹窗中的提示)
                            let afterClickStatus = await extractServerStatus(page);

                            // A. 检查是否提示未到期 (例如后端抛出红色警告条)
                            if (afterClickStatus.isNotTimeToRenew || (await page.getByText("You can't renew your server yet").isVisible().catch(() => false))) {
                                let curExpiry = afterClickStatus.actualExpiry || pageActualExpiry;
                                let daysLeft = parseExpiryDate(curExpiry) || '未知';
                                console.log(`   >> ⏳ 暂无法续期 (时间未到)。下次可续期: ${afterClickStatus.nextAvailableNotice || '未知'}`);
                                
                                if (curExpiry) {
                                    if (renewDates[dedupeKey] !== curExpiry) {
                                        console.log(`[日期矫正] 重新写入本地记录: ${curExpiry}`);
                                        renewDates[dedupeKey] = curExpiry;
                                    }
                                    saveRenewDates(renewDates);
                                }

                                const statusScreenshot = path.join(photoDir, `${safeUsername}_status.png`);
                                try { await saveViewportScreenshot(page, statusScreenshot); } catch (e) {}

                                let nextNoticeText = afterClickStatus.nextAvailableNotice ? `\n⏳ 下次可续期: \`${afterClickStatus.nextAvailableNotice}\`` : '';
                                await sendTelegramMessage(
                                    `🔄 *[@s5gydl] ${escapeMarkdown(user.username)}*\n校正日期成功 (未到续期时间)\n📅 实际有效期: \`${curExpiry || '已校正'}\` (还剩 ${daysLeft} 天)${nextNoticeText}`,
                                    statusScreenshot
                                );

                                stats.skipped++;
                                accountDatesInfo[user.username] = {
                                    status: "🔄 校正成功(未到期)",
                                    nextDate: curExpiry || '已校正',
                                    daysLeft: daysLeft,
                                    node: usedNode
                                };
                                renewPhaseSuccess = true;
                                break;
                            }

                            // B. 检查是否有验证码报错
                            if (await page.getByText('Please complete the captcha to continue').isVisible().catch(() => false)) {
                                console.log('   >> ⚠️ 提示需要验证码，刷新页面重试...');
                                await page.reload();
                                await page.waitForTimeout(3000);
                                if (page.url().includes('login')) break;
                                continue;
                            }

                            // C. 弹窗关闭后的最终验证 (刷新页面比对日期与横幅)
                            if (!await modal.isVisible()) {
                                console.log('   >> 弹窗已关闭，正在刷新页面获取最新状态...');
                                await page.waitForTimeout(2000);
                                try {
                                    await page.reload({ timeout: 10000 });
                                    await page.waitForTimeout(2000);
                                } catch (reloadErr) {
                                    if (user.serverId) {
                                        await page.goto(`https://dashboard.katabump.com/servers/edit?id=${user.serverId}`, { timeout: 15000 }).catch(() => {});
                                        await page.waitForTimeout(2000);
                                    }
                                }

                                const refreshedStatus = await extractServerStatus(page);

                                // 再次确认刷新后是否有未到期红条
                                if (refreshedStatus.isNotTimeToRenew) {
                                    let curExpiry = refreshedStatus.actualExpiry || pageActualExpiry;
                                    let daysLeft = parseExpiryDate(curExpiry) || '未知';
                                    console.log(`   >> ⏳ 刷新后发现未到续期时间。下次可续期: ${refreshedStatus.nextAvailableNotice || '未知'}`);
                                    
                                    if (curExpiry) {
                                        renewDates[dedupeKey] = curExpiry;
                                        saveRenewDates(renewDates);
                                    }

                                    const statusScreenshot = path.join(photoDir, `${safeUsername}_status.png`);
                                    try { await saveViewportScreenshot(page, statusScreenshot); } catch (e) {}

                                    let nextNoticeText = refreshedStatus.nextAvailableNotice ? `\n⏳ 下次可续期: \`${refreshedStatus.nextAvailableNotice}\`` : '';
                                    await sendTelegramMessage(
                                        `🔄 *[@s5gydl] ${escapeMarkdown(user.username)}*\n校正日期成功 (未到续期时间)\n📅 实际有效期: \`${curExpiry || '已校正'}\` (还剩 ${daysLeft} 天)${nextNoticeText}`,
                                        statusScreenshot
                                    );

                                    stats.skipped++;
                                    accountDatesInfo[user.username] = {
                                        status: "🔄 校正成功(未到期)",
                                        nextDate: curExpiry || '已校正',
                                        daysLeft: daysLeft,
                                        node: usedNode
                                    };
                                    renewPhaseSuccess = true;
                                    break;
                                }

                                // 检查日期是否真正发生了更新 (延期)
                                const newExpiry = refreshedStatus.actualExpiry;
                                const isDateExtended = newExpiry && pageActualExpiry && (newExpiry !== pageActualExpiry);

                                if (isDateExtended) {
                                    console.log(`   >> ✅ 续期成功！有效期从 ${pageActualExpiry} 更新至 ${newExpiry}`);
                                    let accurateDays = parseExpiryDate(newExpiry) || '约30';
                                    
                                    renewDates[dedupeKey] = newExpiry;
                                    saveRenewDates(renewDates);

                                    const successScreenshot = path.join(photoDir, `${safeUsername}_success.png`);
                                    try { await saveViewportScreenshot(page, successScreenshot); } catch (e) {}
                                    await sendTelegramMessage(
                                        `✅ *[@s5gydl] ${escapeMarkdown(user.username)}*\n续期成功！\n📅 有效期更新至: \`${newExpiry}\` (还剩 ${accurateDays} 天)`,
                                        successScreenshot
                                    );

                                    stats.success++;
                                    accountDatesInfo[user.username] = {
                                        status: "✅ 续期成功",
                                        nextDate: newExpiry,
                                        daysLeft: accurateDays,
                                        node: usedNode
                                    };
                                    renewPhaseSuccess = true;
                                    break;
                                } else {
                                    // 日期未变且无红条：判定为当前正常、校正日期
                                    let curExpiry = newExpiry || pageActualExpiry || '已校正';
                                    let daysLeft = parseExpiryDate(curExpiry) || '未知';
                                    console.log(`   >> 🔄 日期无需更新或未发生变动 (${curExpiry})，完成校对并同步本地文件`);
                                    
                                    if (newExpiry) {
                                        renewDates[dedupeKey] = newExpiry;
                                        saveRenewDates(renewDates);
                                    }

                                    const statusScreenshot = path.join(photoDir, `${safeUsername}_status.png`);
                                    try { await saveViewportScreenshot(page, statusScreenshot); } catch (e) {}
                                    await sendTelegramMessage(
                                        `🔄 *[@s5gydl] ${escapeMarkdown(user.username)}*\n校正日期成功 (未到续期时间)\n📅 实际有效期: \`${curExpiry}\` (还剩 ${daysLeft} 天)`,
                                        statusScreenshot
                                    );

                                    stats.skipped++;
                                    accountDatesInfo[user.username] = {
                                        status: "🔄 校正成功",
                                        nextDate: curExpiry,
                                        daysLeft: daysLeft,
                                        node: usedNode
                                    };
                                    renewPhaseSuccess = true;
                                    break;
                                }
                            } else {
                                console.log('   >> 模态框未关闭，刷新重试...');
                                await page.reload();
                                await page.waitForTimeout(3000);
                                if (page.url().includes('login')) break;
                                continue;
                            }
                        } else {
                            await page.reload();
                            await page.waitForTimeout(3000);
                            if (page.url().includes('login')) break;
                            continue;
                        }
                    } else {
                        console.log('未找到 Renew 按钮 (可能已结束或暂不可续期)。校对日期并保存。');
                        let curExpiry = pageActualExpiry || '已校正';
                        let daysLeft = parseExpiryDate(curExpiry) || '未知';
                        if (pageActualExpiry) {
                            renewDates[dedupeKey] = pageActualExpiry;
                            saveRenewDates(renewDates);
                        }
                        const statusScreenshot = path.join(photoDir, `${safeUsername}_status.png`);
                        try { await saveViewportScreenshot(page, statusScreenshot); } catch (e) {}
                        await sendTelegramMessage(
                            `🔄 *[@s5gydl] ${escapeMarkdown(user.username)}*\n校正日期成功\n📅 实际有效期: \`${curExpiry}\` (还剩 ${daysLeft} 天)`,
                            statusScreenshot
                        );
                        stats.skipped++;
                        accountDatesInfo[user.username] = {
                            status: "🔄 校正成功",
                            nextDate: curExpiry,
                            daysLeft: daysLeft,
                            node: usedNode
                        };
                        renewPhaseSuccess = true;
                        break;
                    }
                } 

                if (renewPhaseSuccess) {
                    accountSuccess = true;
                    break; 
                } else {
                    accountFailureReason = `续期操作未成功完成`;
                    // Let the account retry loop continue and switch node
                }

            } catch (err) {
                console.error(`处理用户环境遇到异常:`, err.message);
                accountFailureReason = "网络异常或脚本报错";
            }
        }

        if (!accountSuccess && accountDatesInfo[user.username] !== "❌ 登录失败") {
            console.log('   >> ❌ 账号全部重试失败。');
            const failDir = path.join(process.cwd(), 'screenshots');
            if (!fs.existsSync(failDir)) fs.mkdirSync(failDir, { recursive: true });
            const failSafe = user.username.replace(/[^a-z0-9]/gi, '_');
            const failScreenshot = path.join(failDir, `${failSafe}_renew_fail.png`);
            if (page && !page.isClosed()) {
                try { await saveViewportScreenshot(page, failScreenshot); } catch (e) {}
            }
            await sendTelegramMessage(`❌ *[@s5gydl] ${escapeMarkdown(user.username)}*\n${accountFailureReason} (已重试 ${maxAttempts} 次)`, failScreenshot);
            stats.failed++;
            stats.failedAccounts.push(user.username);
            accountDatesInfo[user.username] = {
                status: "❌ 操作失败",
                nextDate: "未知",
                daysLeft: "未知",
                node: usedNode
            };
        }
        
        if (page && !page.isClosed()) {
            const photoDir = path.join(process.cwd(), 'screenshots');
            if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
            const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
            try { await saveViewportScreenshot(page, path.join(photoDir, `${safeUsername}.png`)); } catch (e) {}
            await page.close().catch(()=>{});
        }
    } // <-- Missing closing brace for the users loop added here

    // --- 发送最终汇总报告 ---
    let summaryMessage = `📊 *续期任务汇总报告*\n`;
    summaryMessage += `📢 来源群组: @s5gydl\n\n`;
    
    if (proxyStats.source !== 'NONE') {
        summaryMessage += `🌐 *节点池状态* (${proxyStats.source}):\n`;
        summaryMessage += `- 📥 提取总数: ${proxyStats.total}\n`;
        summaryMessage += `- ✅ 健康有效: ${proxyStats.healthy}\n`;
        summaryMessage += `- ❌ 测速失效: ${proxyStats.invalid}\n\n`;

        if (proxyStats.invalidNodes && proxyStats.invalidNodes.length > 0) {
            summaryMessage += `⚠️ *失效节点清单 (需维护)*:\n`;
            proxyStats.invalidNodes.forEach(node => {
                summaryMessage += `- ❌ \`${escapeMarkdown(node)}\`\n`;
            });
            summaryMessage += `\n`;
        }
    }

    summaryMessage += `🔹 总计账号: ${stats.total}\n`;
    summaryMessage += `✅ 成功续期: ${stats.success}\n`;
    summaryMessage += `🔄 矫正/未到期: ${stats.skipped}\n`;
    summaryMessage += `❌ 失败数量: ${stats.failed}\n\n`;
    
    summaryMessage += `📅 *账号详细信息*:\n`;
    users.forEach(user => {
        let info = accountDatesInfo[user.username];
        if (!info) {
             info = { status: "未知", nextDate: "未知", daysLeft: "未知", node: "未知" };
             let rd = renewDates[user.username.toLowerCase()];
             if (rd) {
                 info.status = "⏳ 之前已成功";
                 info.nextDate = rd;
                 let parsedDays = parseExpiryDate(rd);
                 if (parsedDays !== null) {
                     info.daysLeft = parsedDays;
                 }
             }
        }
        
        summaryMessage += `\n👤 \`${escapeMarkdown(user.username)}\`\n`;
        summaryMessage += ` ├ 状态: ${info.status}\n`;
        summaryMessage += ` ├ 节点: \`${escapeMarkdown(info.node)}\`\n`;
        summaryMessage += ` └ 到期: ${escapeMarkdown(info.nextDate)} (剩 ${info.daysLeft} 天)\n`;
    });

    if (stats.failed > 0) {
        summaryMessage += `\n⚠️ *失败账号清单*:\n`;
        stats.failedAccounts.forEach(acc => {
            summaryMessage += `- \`${escapeMarkdown(acc)}\`\n`;
        });
    }
    
    await sendTelegramMessage(summaryMessage);

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
