const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

app.use(express.static(path.join(__dirname, 'public')));

// DATA & CONFIG
const DATA_FILE = 'game-data.json';
const USD_RATE = 7.8; 
const FEE_RATE = 0.003585; 
const TOTAL_ROUNDS = 5;
// SECURITY: Get password from Environment Variable or default to "admin123"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const INITIAL_MARKET = {
    "700":  { name: "騰訊控股", price: 550, lotSize: 100, type: "stock" },
    "2800": { name: "盈富基金", price: 25,  lotSize: 500, type: "stock" },
    "9988": { name: "阿里巴巴", price: 150, lotSize: 100, type: "stock" },
    "9992": { name: "泡泡瑪特", price: 240, lotSize: 200, type: "stock" },
    "981":  { name: "中芯國際", price: 65,  lotSize: 500, type: "stock" },
    "2899": { name: "紫金礦業", price: 40,  lotSize: 2000, type: "stock" },
    "388":  { name: "香港交易所", price: 100, lotSize: 100, type: "stock" },
    "0005": { name: "匯豐控股", price: 135, lotSize: 400, type: "stock" },
    "AgBank":     { name: "農行/香港 (HKD)", price: 100, lotSize: 100, type: "bond", coupon: 2.31, minEntry: 10000 },
    "USTreasury": { name: "美國國債 (USD)", price: 100 * USD_RATE, lotSize: 10, type: "bond", coupon: 4.625, minEntry: 70000 * USD_RATE },
    "Airport":    { name: "機管局零售債 (HKD)", price: 100, lotSize: 100, type: "bond", coupon: 4.25, minEntry: 10000 },
    "Nvidia":     { name: "NVIDIA債券 (USD)", price: 100 * USD_RATE, lotSize: 10, type: "bond", coupon: 3.20, minEntry: 70000 * USD_RATE },
    "Apple":      { name: "Apple債券 (USD)", price: 100 * USD_RATE, lotSize: 10, type: "bond", coupon: 3.00, minEntry: 70000 * USD_RATE },
    "Gold": { name: "999.9 黃金金條", price: 49480, lotSize: 1, type: "gold" }
};

const MARKET_EVENTS = [
    { title: "AI 技術大突破！", desc: "ChatGPT 推出新版本，全球科技股狂歡。", effect: (market) => { market["700"].price *= 1.15; market["981"].price *= 1.20; market["9988"].price *= 1.10; market["Nvidia"].price *= 1.05; } },
    { title: "美聯儲宣佈大幅加息", desc: "為了對抗通脹，利率上調 0.5%，股市承壓。", effect: (market) => { market["2800"].price *= 0.92; market["0005"].price *= 1.05; market["Gold"].price *= 0.95; market["USTreasury"].price *= 0.98; } },
    { title: "地緣政治緊張局勢升溫", desc: "中東局勢不穩，避險資金湧入黃金。", effect: (market) => { market["Gold"].price *= 1.15; market["2899"].price *= 1.10; market["2800"].price *= 0.90; } },
    { title: "中國推出消費刺激政策", desc: "政府發放消費券，零售業迎來春天。", effect: (market) => { market["9992"].price *= 1.25; market["9988"].price *= 1.10; market["700"].price *= 1.05; } },
    { title: "全球半導體供應鏈短缺", desc: "晶片產能不足，相關企業價格飆升。", effect: (market) => { market["981"].price *= 1.30; market["700"].price *= 0.95; market["Apple"].price *= 0.98; } },
    { title: "環球股市崩盤恐慌", desc: "華爾街黑天鵝事件，全球遭殃。", effect: (market) => { ["700", "2800", "9988", "9992", "981", "2899", "388", "0005"].forEach(c => { market[c].price *= (0.8 + Math.random()*0.1); }); market["Gold"].price *= 1.10; market["USTreasury"].price *= 1.05; } },
    { title: "市場平穩", desc: "沒有重大新聞，價格隨機波動。", effect: (market) => { for(let c in market) { if(market[c].type === 'stock') market[c].price *= (0.95 + Math.random()*0.1); } } }
];

let gameState = {
    round: 0,
    market: JSON.parse(JSON.stringify(INITIAL_MARKET)),
    players: {},
    lastEvent: null
};

// In production (Render), we don't usually use persistent file storage for free tier, 
// but we keep this for local testing.
if (fs.existsSync(DATA_FILE)) { try { gameState = JSON.parse(fs.readFileSync(DATA_FILE)); } catch(e){} }

function saveGame() { 
    // On Render/Heroku free tier, files are wiped on restart. 
    // This is fine for a temporary session.
    fs.writeFileSync(DATA_FILE, JSON.stringify(gameState, null, 2)); 
}

io.on('connection', (socket) => {
    // UPDATED: Join Game now accepts an object for Host Login
    socket.on('join_game', (type, payload) => {
        
        // === HOST LOGIN LOGIC ===
        if (type === 'host') {
            // Check password
            if (payload !== ADMIN_PASSWORD) {
                socket.emit('error_msg', '管理員密碼錯誤 (Wrong Password)');
                return;
            }
            // Password Correct
            socket.emit('host_login_success');
            updateHost();
            return;
        }

        // === PLAYER LOGIN LOGIC ===
        if (type === 'player') {
            let name = payload;
            let existingId = Object.keys(gameState.players).find(id => gameState.players[id].name === name);
            if (existingId) {
                gameState.players[socket.id] = gameState.players[existingId];
                delete gameState.players[existingId];
            } else {
                gameState.players[socket.id] = {
                    name: name || `Player-${socket.id.substr(0,4)}`,
                    cash: 1000000, timeDeposit: 0, portfolio: {} 
                };
                Object.keys(INITIAL_MARKET).forEach(code => gameState.players[socket.id].portfolio[code] = 0);
            }
            saveGame();
            socket.emit('init_player', { player: gameState.players[socket.id], market: gameState.market, round: gameState.round, lastEvent: gameState.lastEvent });
            updateHost(); // Update host when player joins
        }
    });

    socket.on('trade', (action, code, lots) => {
        let player = gameState.players[socket.id];
        let item = gameState.market[code];
        if (!player || !item) return;

        lots = parseInt(lots);
        if (isNaN(lots) || lots <= 0) return socket.emit('error_msg', "無效數量");
        if (lots > 100) return socket.emit('error_msg', "單次交易上限為 100 手");

        let quantity = lots * item.lotSize;
        let amount = item.price * quantity;
        let fee = item.type === 'stock' ? amount * FEE_RATE : 0; 

        if (action === 'buy') {
            let totalCost = amount + fee;
            if (item.type === 'bond' && amount < item.minEntry) return socket.emit('error_msg', `未達最低入場費 $${item.minEntry.toLocaleString()}`);
            if (player.cash >= totalCost) {
                player.cash -= totalCost;
                player.portfolio[code] += quantity;
                socket.emit('update_player', { player, msg: `成功買入 ${item.name} ${lots} 手` });
            } else { socket.emit('error_msg', "現金不足"); }
        } else if (action === 'sell') {
            if (player.portfolio[code] >= quantity) {
                let totalGain = amount - fee;
                player.cash += totalGain;
                player.portfolio[code] -= quantity;
                socket.emit('update_player', { player, msg: `成功賣出 ${item.name} ${lots} 手` });
            } else { socket.emit('error_msg', "持倉不足"); }
        }
        saveGame();
        updateHost();
    });

    socket.on('time_deposit_action', (action, amount) => {
        let player = gameState.players[socket.id];
        amount = parseInt(amount);
        if (!player || amount <= 0) return;
        if (action === 'deposit') {
            if (player.cash >= amount) {
                player.cash -= amount; player.timeDeposit += amount;
                socket.emit('update_player', { player, msg: `存入定存 $${amount}` });
            } else { socket.emit('error_msg', "現金不足"); }
        } else if (action === 'withdraw') {
            if (player.timeDeposit >= amount) {
                player.timeDeposit -= amount; player.cash += amount;
                socket.emit('update_player', { player, msg: `取出定存 $${amount}` });
            } else { socket.emit('error_msg', "存款不足"); }
        }
        saveGame();
        updateHost();
    });

    socket.on('next_round_action', () => {
        if (gameState.round < TOTAL_ROUNDS) {
            gameState.round++;
            triggerRandomEvent();
            processRoundYields();
            saveGame();
            io.emit('new_round', { round: gameState.round, market: gameState.market, event: gameState.lastEvent });
            updateHost();
        }
    });

    socket.on('reset_game', () => {
        gameState.round = 0;
        gameState.market = JSON.parse(JSON.stringify(INITIAL_MARKET));
        gameState.players = {};
        gameState.lastEvent = null;
        io.emit('host_update', gameState);
    });
});

function triggerRandomEvent() {
    const event = MARKET_EVENTS[Math.floor(Math.random() * MARKET_EVENTS.length)];
    event.effect(gameState.market);
    for(let code in gameState.market) gameState.market[code].price = parseFloat(gameState.market[code].price.toFixed(2));
    gameState.lastEvent = { title: event.title, desc: event.desc };
}

function processRoundYields() {
    for (let id in gameState.players) {
        let p = gameState.players[id];
        let rate = p.timeDeposit >= 500000 ? 0.05 : 0.03;
        if(p.timeDeposit > 0) p.timeDeposit += Math.floor(p.timeDeposit * rate);
        for(let code in p.portfolio) {
            let item = gameState.market[code];
            if (item.type === 'bond' && p.portfolio[code] > 0) {
                let coupon = Math.floor(p.portfolio[code] * item.price * (item.coupon / 100 / 4)); 
                if(coupon > 0) p.cash += coupon;
            }
        }
    }
}

function updateHost() { io.emit('host_update', gameState); }

// IMPORTANT: Use process.env.PORT for deployment
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`Game Server running on port ${PORT}`); });