require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

app.use(express.static(path.join(__dirname, 'public')));

// --- 設定 ---
const DATA_FILE = 'game-data.json';
const USD_RATE = 7.8; 
const FEE_RATE = 0.003585; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// --- 定存利率表 (1 Round = 3 Months) ---
const DEPOSIT_OPTS = {
    3:  { label: "3 個月 (1 回合)", rounds: 1, rate: 0.00125 }, // 0.125% p.a.
    6:  { label: "6 個月 (2 回合)", rounds: 2, rate: 0.00125 }, // 0.125% p.a.
    9:  { label: "9 個月 (3 回合)", rounds: 3, rate: 0.00150 }, // 0.150% p.a.
    12: { label: "12 個月 (4 回合)", rounds: 4, rate: 0.00150 } // 0.150% p.a.
};

// --- 初始市場 ---
const INITIAL_MARKET = {
    "700":  { name: "騰訊控股", price: 550, lotSize: 100, type: "stock" },
    "2800": { name: "盈富基金", price: 25,  lotSize: 500, type: "stock" },
    "9988": { name: "阿里巴巴", price: 150, lotSize: 100, type: "stock" },
    "9992": { name: "泡泡瑪特", price: 240, lotSize: 200, type: "stock" },
    "981":  { name: "中芯國際", price: 65,  lotSize: 500, type: "stock" },
    "2899": { name: "紫金礦業", price: 40,  lotSize: 2000, type: "stock" },
    "388":  { name: "香港交易所", price: 100, lotSize: 100, type: "stock" },
    "0005": { name: "匯豐控股", price: 135, lotSize: 400, type: "stock" },
    "AgBank":     { name: "農行香港 2.31%", price: 100, lotSize: 100, type: "bond", coupon: 2.31, minEntry: 10000 },
    "USTreasury": { name: "美國國債 4.625%", price: 100 * USD_RATE, lotSize: 10, type: "bond", coupon: 4.625, minEntry: 70000 * USD_RATE },
    "Airport":    { name: "機管局 4.25%", price: 100, lotSize: 100, type: "bond", coupon: 4.25, minEntry: 10000 },
    "Nvidia":     { name: "NVIDIA 3.2%", price: 100 * USD_RATE, lotSize: 10, type: "bond", coupon: 3.20, minEntry: 70000 * USD_RATE },
    "Apple":      { name: "Apple 3.0%", price: 100 * USD_RATE, lotSize: 10, type: "bond", coupon: 3.00, minEntry: 70000 * USD_RATE },
    "Gold": { name: "999.9 黃金金條", price: 49480, lotSize: 1, type: "gold" } 
};

// --- 新聞事件 ---
const MARKET_EVENTS = [
    { title: "AI 技術大突破！", desc: "ChatGPT 推出新版本，全球科技股狂歡。", effect: (market) => { if(market["700"]) market["700"].price *= 1.15; if(market["981"]) market["981"].price *= 1.20; if(market["9988"]) market["9988"].price *= 1.10; if(market["Nvidia"]) market["Nvidia"].price *= 1.05; } },
    { title: "美聯儲宣佈大幅加息", desc: "為了對抗通脹，利率上調 0.5%，股市承壓。", effect: (market) => { if(market["2800"]) market["2800"].price *= 0.92; if(market["0005"]) market["0005"].price *= 1.05; if(market["Gold"]) market["Gold"].price *= 0.95; if(market["USTreasury"]) market["USTreasury"].price *= 0.98; } },
    { title: "地緣政治緊張局勢升溫", desc: "中東局勢不穩，避險資金湧入黃金。", effect: (market) => { if(market["Gold"]) market["Gold"].price *= 1.15; if(market["2899"]) market["2899"].price *= 1.10; if(market["2800"]) market["2800"].price *= 0.90; } },
    { title: "中國推出消費刺激政策", desc: "政府發放消費券，零售業迎來春天。", effect: (market) => { if(market["9992"]) market["9992"].price *= 1.25; if(market["9988"]) market["9988"].price *= 1.10; if(market["700"]) market["700"].price *= 1.05; } },
    { title: "全球半導體供應鏈短缺", desc: "晶片產能不足，相關企業價格飆升。", effect: (market) => { if(market["981"]) market["981"].price *= 1.30; if(market["700"]) market["700"].price *= 0.95; if(market["Apple"]) market["Apple"].price *= 0.98; } },
    { title: "環球股市崩盤恐慌", desc: "華爾街黑天鵝事件，全球遭殃。", effect: (market) => { ["700", "2800", "9988", "9992", "981", "2899", "388", "0005"].forEach(c => { if(market[c]) market[c].price *= (0.8 + Math.random()*0.1); }); if(market["Gold"]) market["Gold"].price *= 1.10; if(market["USTreasury"]) market["USTreasury"].price *= 1.05; } },
    { title: "市場平穩", desc: "沒有重大新聞，價格隨機波動。", effect: (market) => { for(let c in market) { if(market[c].type === 'stock') market[c].price *= (0.95 + Math.random()*0.1); } } }
];

let gameState = {
    round: 0,
    status: 'active',
    market: JSON.parse(JSON.stringify(INITIAL_MARKET)),
    players: {}, // 現在改為以 userId 作為 Key，確保連線穩定
    lastEvent: null
};

// 記憶體中的 Socket 對應表，避免多開分頁崩潰
const socketToUser = {};

if (fs.existsSync(DATA_FILE)) { 
    try { 
        gameState = JSON.parse(fs.readFileSync(DATA_FILE)); 
        // 向後兼容：如果讀取的存檔還是舊的 socket.id 格式，自動轉換為 userId 格式
        let migratedPlayers = {};
        for (let key in gameState.players) {
            let p = gameState.players[key];
            if (p.userId) migratedPlayers[p.userId] = p;
        }
        gameState.players = migratedPlayers;
    } catch(e) { console.error("存檔讀取失敗:", e); } 
}
function saveGame() { fs.writeFileSync(DATA_FILE, JSON.stringify(gameState, null, 2)); }

io.on('connection', (socket) => {
    socket.on('disconnect', () => {
        delete socketToUser[socket.id];
    });

    socket.on('join_game', (type, payload) => {
        if (type === 'host') {
            if (payload !== ADMIN_PASSWORD) return socket.emit('error_msg', '密碼錯誤');
            socket.emit('host_login_success');
            updateHost();
        } else if (type === 'player') {
            const { name, userId } = payload;
            if (!userId) return socket.emit('login_failed', '無效的用戶資料');

            // 檢查名稱是否被其他 userId 佔用
            let nameTakenUser = Object.values(gameState.players).find(p => p.name === name && p.userId !== userId);
            if (nameTakenUser) {
                return socket.emit('login_failed', '名稱已被使用，請換一個名字！');
            }

            // 將連線綁定到特定的 userId，允許同一用戶多開分頁同步操作
            socketToUser[socket.id] = userId;
            socket.join(userId); 

            if (gameState.players[userId]) {
                // 重連：更新為最新名稱
                gameState.players[userId].name = name || gameState.players[userId].name;
                
                // 確保作品集包含市場最新股票 (防止伺服器新增股票後舊玩家崩潰)
                Object.keys(gameState.market).forEach(code => {
                    if (gameState.players[userId].portfolio[code] === undefined) {
                        gameState.players[userId].portfolio[code] = 0;
                    }
                });
            } else {
                // 新玩家
                gameState.players[userId] = {
                    name: name || `Player-${socket.id.substr(0,4)}`,
                    userId: userId,
                    cash: 1000000, 
                    deposits: [],
                    portfolio: {} 
                };
                Object.keys(gameState.market).forEach(code => {
                    gameState.players[userId].portfolio[code] = 0;
                });
            }
            saveGame();
            
            if(gameState.status === 'ended') {
                // 為兼容前端 `data.players[socket.id]` 邏輯，單獨發送時注入 alias
                let payloadPlayers = { ...gameState.players };
                payloadPlayers[socket.id] = gameState.players[userId];
                socket.emit('game_over', { players: payloadPlayers, market: gameState.market });
            } else {
                socket.emit('init_player', { player: gameState.players[userId], market: gameState.market, round: gameState.round, lastEvent: gameState.lastEvent });
            }
            updateHost();
        }
    });

    socket.on('trade', (action, code, lots) => {
        if(gameState.status === 'ended') return socket.emit('error_msg', "遊戲已結束");
        
        let userId = socketToUser[socket.id];
        let player = gameState.players[userId];
        let item = gameState.market[code];
        // 防止 Socket 重啟後客戶端找不到人的靜默崩潰
        if (!player || !item) return socket.emit('login_failed', "連線已失效或伺服器重啟，請重新整理頁面。");

        lots = parseInt(lots);
        if (isNaN(lots) || lots <= 0) return socket.emit('error_msg', "無效數量");
        if (lots > 100) return socket.emit('error_msg', "單次交易上限為 100 手");

        let quantity = lots * item.lotSize;
        let amount = item.price * quantity;
        let fee = item.type === 'stock' ? amount * FEE_RATE : 0; 

        if (action === 'buy') {
            let totalCost = amount + fee;
            if (item.type === 'bond' && amount < item.minEntry) return socket.emit('error_msg', `未達最低入場費 $${item.minEntry.toLocaleString()}`);
            if (player.cash >= totalCost - 0.01) { // 預防浮點數精度問題
                player.cash = Math.max(0, player.cash - totalCost);
                player.portfolio[code] += quantity; 
                // 發送給該 user 的所有分頁 (跨分頁即時同步)
                io.to(userId).emit('update_player', { player, msg: `成功買入 ${lots} ${item.type==='gold'?'兩':'手'}` });
            } else { socket.emit('error_msg', "現金不足"); }
        } else if (action === 'sell') {
            if (player.portfolio[code] >= quantity) {
                let totalGain = amount - fee;
                player.cash += totalGain;
                player.portfolio[code] -= quantity;
                io.to(userId).emit('update_player', { player, msg: `成功賣出 ${lots} ${item.type==='gold'?'兩':'手'}` });
            } else { socket.emit('error_msg', "持倉不足"); }
        }
        saveGame();
        updateHost();
    });

    socket.on('create_deposit', (amount, durationMonths) => {
        if(gameState.status === 'ended') return;
        let userId = socketToUser[socket.id];
        let player = gameState.players[userId];
        if (!player) return socket.emit('login_failed', "連線已失效，請重新整理頁面。");

        amount = parseInt(amount);
        durationMonths = parseInt(durationMonths);
        
        if (isNaN(amount) || amount <= 0) return socket.emit('error_msg', "無效金額");
        if (player.cash < amount) return socket.emit('error_msg', "現金不足");
        const opt = DEPOSIT_OPTS[durationMonths];
        if (!opt) return socket.emit('error_msg', "無效的存款期限");

        player.cash -= amount;
        player.deposits.push({
            id: Date.now(),
            amount: amount,
            duration: durationMonths,
            rate: opt.rate,
            startRound: gameState.round,
            maturityRound: gameState.round + opt.rounds
        });
        io.to(userId).emit('update_player', { player, msg: `成功建立 ${opt.label} 定存` });
        saveGame();
        updateHost();
    });

    socket.on('next_round_action', () => {
        if(gameState.status === 'ended') return;
        gameState.round++;
        
        triggerRandomEvent();
        processEndOfRound();
        saveGame();
        
        io.emit('new_round', { round: gameState.round, market: gameState.market, event: gameState.lastEvent });
        // 發送資料給所有使用者的房間
        for (let userId in gameState.players) {
            io.to(userId).emit('update_player', { player: gameState.players[userId], msg: null });
        }
        updateHost();
    });

    socket.on('end_game_action', () => {
        gameState.status = 'ended';
        saveGame();
        
        // 為了相容前端 data.players[socket.id] 寫法
        let payloadPlayers = { ...gameState.players };
        for (let sid in socketToUser) {
            let uid = socketToUser[sid];
            if (payloadPlayers[uid]) payloadPlayers[sid] = payloadPlayers[uid]; 
        }
        
        io.emit('game_over', { players: payloadPlayers, market: gameState.market });
        updateHost();
    });

    socket.on('reset_game', () => {
        gameState.round = 0;
        gameState.status = 'active';
        gameState.market = JSON.parse(JSON.stringify(INITIAL_MARKET));
        gameState.players = {};
        gameState.lastEvent = null;
        if(fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
        io.emit('init_player', { player: null, market: gameState.market, round: 0, reload: true });
        updateHost();
    });
});

function triggerRandomEvent() {
    const event = MARKET_EVENTS[Math.floor(Math.random() * MARKET_EVENTS.length)];
    let oldPrices = {};
    for (let code in gameState.market) oldPrices[code] = gameState.market[code].price;
    event.effect(gameState.market);
    for(let code in gameState.market) {
        // 防止價格跌破零
        let newPrice = Math.max(0.01, parseFloat(gameState.market[code].price.toFixed(2)));
        gameState.market[code].price = newPrice;
        let oldPrice = oldPrices[code];
        gameState.market[code].change = newPrice - oldPrice;
        gameState.market[code].changePercent = ((newPrice - oldPrice) / oldPrice) * 100;
    }
    gameState.lastEvent = { title: event.title, desc: event.desc };
}

function processEndOfRound() {
    for (let id in gameState.players) {
        let p = gameState.players[id];
        let activeDeposits = [];
        p.deposits.forEach(dep => {
            if (gameState.round >= dep.maturityRound) {
                let interest = Math.floor(dep.amount * dep.rate * (dep.duration / 12));
                p.cash += (dep.amount + interest);
            } else {
                activeDeposits.push(dep);
            }
        });
        p.deposits = activeDeposits; 

        for(let code in p.portfolio) {
            let item = gameState.market[code];
            // 安全防護：確定物品仍存在於市場上
            if (item && item.type === 'bond' && p.portfolio[code] > 0) {
                let holdingVal = p.portfolio[code] * item.price;
                let coupon = Math.floor(holdingVal * (item.coupon / 100 / 4)); 
                if(coupon > 0) p.cash += coupon;
            }
        }
    }
}

function updateHost() { io.emit('host_update', gameState); }
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`Game Server running on port ${PORT}`); });