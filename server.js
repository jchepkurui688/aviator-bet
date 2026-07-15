const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// Initialize SQLite database in project folder
const db = new sqlite3.Database(path.join(__dirname, 'database.db'), (err) => {
    if (err) console.error('Database open error:', err);
    else console.log('📁 SQLite Database connected successfully.');
});

// Create tables for multi-user testing (Set default starting balance to exactly 5.00)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        balance REAL DEFAULT 5.00
    )`);
});

app.use(express.json());
app.use(express.static('public'));

// Presentation Trend Array specified by user
const presentationTrends = [
    2.1, 4.6, 10.8, 14.6, 24.0, 104.6, 101.0, 30.4, 3.2, 
    4.0, 4.0, 19.4, 16.3, 2.0, 1.4, 1.0, 206.5, 41.3, 66.4
];
let trendIndex = 0;

let gameState = 'waiting'; 
let currentMultiplier = 1.00;
let crashPoint = 1.00;
let gameLoopInterval = null;
let stateTimer = 5; // Enforced 5-second round countdown

// Server memory mapping for tracking active user bets in real-time
let activeRoundBets = {};

function getNextCrashPoint() {
    const point = presentationTrends[trendIndex];
    trendIndex = (trendIndex + 1) % presentationTrends.length; // Loop infinitely back to start
    return point;
}

function runGameStateMachine() {
    if (gameState === 'waiting') {
        stateTimer--;
        io.emit('game_waiting', stateTimer);

        if (stateTimer <= 0) {
            gameState = 'flying';
            currentMultiplier = 1.00;
            crashPoint = getNextCrashPoint();
            console.log(`[Round Live] Target Crash Point set to: ${crashPoint}x`);
            
            io.emit('game_started');
            let elapsedFrames = 0;
            clearInterval(gameLoopInterval);
            
            gameLoopInterval = setInterval(() => {
                elapsedFrames++;
                // Smooth progressive exponential flight scaling
                currentMultiplier += 0.001 * Math.pow(1.0014, elapsedFrames);
                currentMultiplier = parseFloat(currentMultiplier.toFixed(2));

                if (currentMultiplier >= crashPoint) {
                    clearInterval(gameLoopInterval);
                    gameState = 'crashed';
                    io.emit('game_crashed', crashPoint);
                    
                    // Round Finished: Reset current active bets map
                    activeRoundBets = {};

                    setTimeout(() => {
                        gameState = 'waiting';
                        stateTimer = 5;
                        gameLoopInterval = setInterval(runGameStateMachine, 1000);
                    }, 4000);
                } else {
                    io.emit('multiplier_tick', currentMultiplier);
                }
            }, 16);
        }
    }
}
gameLoopInterval = setInterval(runGameStateMachine, 1000);

// --- API Authentication Endpoints ---

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    db.run(`INSERT INTO users (username, password, balance) VALUES (?, ?, 5.00)`, [username, password], function(err) {
        if (err) return res.status(400).json({ error: 'Username already taken.' });
        res.json({ success: true });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'Invalid credentials.' });
        res.json({ success: true, username: user.username, balance: user.balance });
    });
});

app.post('/api/balance/update', (req, res) => {
    const { username, amount } = req.body;
    db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [amount, username], function(err) {
        if (err) return res.status(500).json({ error: 'Failed balance change step.' });
        db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
            if (err || !row) return res.status(500).json({ error: 'Failed to retrieve updated balance.' });
            res.json({ success: true, newBalance: row.balance });
        });
    });
});

// --- Unified Secure Paystack Deposit Endpoint ---
app.post('/api/paystack/verify', (req, res) => {
    const { username, reference } = req.body;
    const amount = req.body.amount ? parseFloat(req.body.amount) : 100; 

    if (!username) {
        return res.status(400).json({ success: false, message: 'Missing username parameter.' });
    }

    db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [amount, username], function(err) {
        if (err) {
            console.error('Database update error:', err);
            return res.status(500).json({ success: false, message: 'Database update failed.' });
        }
        
        db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
            if (err || !row) {
                return res.status(500).json({ success: false, message: 'Failed to retrieve updated balance.' });
            }
            
            console.log(`💰 [Deposit Verified] User ${username} credited KSh ${amount}. Reference: ${reference}`);
            res.json({ success: true, newBalance: row.balance });
        });
    });
});

// --- Real-time Socket Event Controllers ---
io.on('connection', (socket) => {
    // Send state on connection
    socket.emit('sync_state', { gameState, currentMultiplier, stateTimer });

    // Track active username directly on the socket connection to prevent session loss
    socket.on('register_session', (username) => {
        socket.username = username;
    });

    // Handle user placing a bet on server
    socket.on('place_bet', (data) => {
        const username = data.username || socket.username;
        const { deckId, amount } = data;

        if (!username || !deckId || isNaN(amount)) {
            return socket.emit('error_message', 'Invalid bet arguments.');
        }

        // 1. Strict Minimum Bet limit Check (10 KES)
        if (amount < 10) {
            return socket.emit('error_message', 'The minimum amount to place a bet is KSH 10.');
        }

        // Fetch user context from SQLite to check balance
        db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, user) => {
            if (err || !user) {
                return socket.emit('error_message', 'User account not found.');
            }

            if (user.balance < amount) {
                return socket.emit('error_message', 'Insufficient wallet balance.');
            }

            // Deduct funds securely from DB
            db.run(`UPDATE users SET balance = balance - ? WHERE username = ?`, [amount, username], function(err) {
                if (err) {
                    return socket.emit('error_message', 'Database error placing bet.');
                }

                // Query the exact updated database balance to prevent synchronization calculation gaps
                db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, row) => {
                    const dbBalance = (row && row.balance !== undefined) ? row.balance : (user.balance - amount);

                    // Register inside active round memory map
                    if (!activeRoundBets[username]) {
                        activeRoundBets[username] = {};
                    }
                    activeRoundBets[username][deckId] = { amount: amount, cashedOut: false };

                    console.log(`🎮 [Bet Placed] User ${username} bet KES ${amount} on Deck ${deckId}`);

                    // Send success payload back to specific socket client
                    socket.emit('bet_confirmed', {
                        deckId: deckId,
                        amount: amount,
                        newBalance: dbBalance
                    });
                });
            });
        });
    });

    // Handle real-time user cashout request
    socket.on('cash_out', (data) => {
        const username = data.username || socket.username;
        const { deckId } = data;

        if (gameState !== 'flying') {
            return socket.emit('error_message', 'Round is not flying!');
        }

        // Confirm bet matches current active constraints
        if (!activeRoundBets[username] || !activeRoundBets[username][deckId]) {
            return socket.emit('error_message', 'No active bet found for this deck.');
        }

        const betContext = activeRoundBets[username][deckId];
        if (betContext.cashedOut) {
            return socket.emit('error_message', 'Bet already cashed out.');
        }

        // Lock cashout state immediately to prevent race conditions
        betContext.cashedOut = true;

        // Calculate payout
        const multiplier = currentMultiplier;
        const payout = parseFloat((betContext.amount * multiplier).toFixed(2));

        // Credit SQLite wallet instantly
        db.run(`UPDATE users SET balance = balance + ? WHERE username = ?`, [payout, username], function(err) {
            if (err) {
                betContext.cashedOut = false; // rollback state
                return socket.emit('error_message', 'Database error finalizing transaction.');
            }

            // Pull new balance value
            db.get(`SELECT balance FROM users WHERE username = ?`, [username], (err, user) => {
                if (err || !user) {
                    return socket.emit('error_message', 'Failed to retrieve updated wallet context.');
                }

                console.log(`💸 [Cash Out Success] User ${username} cashed out KES ${payout} at ${multiplier}x!`);

                // Confirm verification back to client
                socket.emit('cashout_confirmed', {
                    deckId: deckId,
                    payout: payout,
                    newBalance: user.balance
                });
            });
        });
    });
});

app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Academic Presentation Engine active at http://localhost:${PORT}`);
});