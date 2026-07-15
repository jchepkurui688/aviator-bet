// Global State Context Variables
let socket;
let currentUser = null;
let currentBalance = 0.00;

// Canvas details
let canvas, ctx;

// Local User Bet State Tracking (Deck 1 and Deck 2)
let localBets = {
    1: { active: false, amount: 0, cashedOut: false },
    2: { active: false, amount: 0, cashedOut: false }
};

let gameLifecycle = 'waiting'; // 'waiting', 'flying', 'crashed'
let activeMultiplier = 1.00;

// Canvas Render Variables
let flightProgress = 0;
let currentX = 50;
let currentY = 300;

// High-Performance Vector Plane Drawing Function (Matches Red Classic Propeller Shape)
function drawPropellerPlane(ctx, x, y, width = 65, height = 30) {
    ctx.save();
    ctx.translate(x, y);

    // Subtle floating animation rotation while flying
    const angle = Math.sin(Date.now() * 0.01) * 0.04;
    ctx.rotate(angle);

    ctx.fillStyle = '#e91e63';
    ctx.strokeStyle = '#c2185b';
    ctx.lineWidth = 1.5;

    // --- Main Fuselage Body ---
    ctx.beginPath();
    ctx.moveTo(-width / 2, -height / 6);
    ctx.lineTo(-width / 2, height / 6);
    ctx.quadraticCurveTo(-width / 3, height / 2, 0, height / 2);
    ctx.lineTo(width * 0.4, height / 3);
    ctx.lineTo(width * 0.5, 0); // Nose cone tip
    ctx.lineTo(width * 0.4, -height / 3);
    ctx.lineTo(0, -height / 2);
    ctx.quadraticCurveTo(-width / 3, -height / 2, -width / 2, -height / 6);
    ctx.fill();
    ctx.stroke();

    // --- Wings (Angled forward slightly) ---
    ctx.fillStyle = '#d81b60';
    ctx.beginPath();
    ctx.moveTo(-width * 0.1, -height * 0.4);
    ctx.lineTo(-width * 0.25, -height * 1.3);
    ctx.lineTo(-width * 0.05, -height * 1.3);
    ctx.lineTo(width * 0.1, -height * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-width * 0.1, height * 0.4);
    ctx.lineTo(-width * 0.25, height * 1.3);
    ctx.lineTo(-width * 0.05, height * 1.3);
    ctx.lineTo(width * 0.1, height * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // --- Tail / Rudder Fins ---
    ctx.fillStyle = '#c2185b';
    ctx.beginPath();
    ctx.moveTo(-width * 0.5, -height * 0.1);
    ctx.lineTo(-width * 0.65, -height * 0.6);
    ctx.lineTo(-width * 0.55, -height * 0.6);
    ctx.lineTo(-width * 0.4, -height * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // --- Propeller Axis Spin lines ---
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(width * 0.5, -height * 0.7);
    ctx.lineTo(width * 0.5, height * 0.7);
    ctx.stroke();

    ctx.restore();
}

document.addEventListener('DOMContentLoaded', () => {
    // Initialize Canvas Context
    canvas = document.getElementById('flightCanvas');
    if (canvas) {
        ctx = canvas.getContext('2d');
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
    }

    // Connect to Backend Socket.io Server
    socket = io();

    // Setup Server Observers
    socket.on('sync_state', (state) => {
        console.log("Syncing state from server:", state);
        gameLifecycle = state.gameState;
        activeMultiplier = state.currentMultiplier;
        updateGameDisplay(state.gameState, state.currentMultiplier, state.stateTimer);
        if (gameLifecycle === 'flying') {
            updateButtonsOnFlightStart();
        }
    });

    socket.on('game_waiting', (timer) => {
        gameLifecycle = 'waiting';
        activeMultiplier = 1.00;
        resetBettingsUI('waiting');
        updateGameDisplay('waiting', 1.00, timer);
    });

    socket.on('game_started', () => {
        console.log("🚀 Game Started! Flying state triggered.");
        gameLifecycle = 'flying';
        activeMultiplier = 1.00;
        resetFlightAnimation();
        updateGameDisplay('flying', 1.00);
        // Transition waiting bets to Cash Out buttons instantly
        updateButtonsOnFlightStart();
    });

    socket.on('multiplier_tick', (mult) => {
        gameLifecycle = 'flying';
        activeMultiplier = mult;
        updateGameDisplay('flying', mult);
        updatePayoutTicks();
    });

    socket.on('game_crashed', (finalMult) => {
        console.log("💥 Game Crashed at:", finalMult);
        gameLifecycle = 'crashed';
        activeMultiplier = finalMult;
        updateGameDisplay('crashed', finalMult);
        handleBetsOnCrash();
    });

    // Listen for transaction callbacks from backend updates
    socket.on('bet_confirmed', (data) => {
        console.log("✅ Bet confirmed by server:", data);
        const { deckId, amount, newBalance } = data;
        currentBalance = newBalance;
        
        const balanceElem = document.getElementById('navBalance');
        if (balanceElem) {
            balanceElem.innerText = 'KES ' + parseFloat(newBalance).toFixed(2);
        }
        
        localBets[deckId].active = true;
        localBets[deckId].amount = amount;
        localBets[deckId].cashedOut = false;

        const actionBtn = document.getElementById(`btnAction-${deckId}`);
        if (actionBtn) {
            // RACE CONDITION FIX: If the game is already in flight, go directly to CASHOUT
            if (gameLifecycle === 'flying') {
                actionBtn.className = 'main-action-trigger btn-cashout';
                document.getElementById(`btnTitle-${deckId}`).innerText = 'Cash Out';
                const currentPayout = amount * activeMultiplier;
                document.getElementById(`btnSub-${deckId}`).innerText = `${currentPayout.toFixed(2)} KES`;
            } else {
                // Otherwise, show the visual waiting queue
                actionBtn.className = 'main-action-trigger btn-waiting';
                document.getElementById(`btnTitle-${deckId}`).innerText = 'Waiting Round';
                document.getElementById(`btnSub-${deckId}`).innerText = 'Submitting Bet';
            }
        }
    });

    socket.on('cashout_confirmed', (data) => {
        console.log("💸 Cashout confirmed by server:", data);
        const { deckId, payout, newBalance } = data;
        currentBalance = newBalance;
        
        const balanceElem = document.getElementById('navBalance');
        if (balanceElem) {
            balanceElem.innerText = 'KES ' + parseFloat(newBalance).toFixed(2);
        }

        localBets[deckId].cashedOut = true;
        localBets[deckId].active = false;

        // Revert UI to Bet State
        const actionBtn = document.getElementById(`btnAction-${deckId}`);
        if (actionBtn) {
            actionBtn.className = 'main-action-trigger btn-bet';
            document.getElementById(`btnTitle-${deckId}`).innerText = 'Bet';
            const val = parseFloat(document.getElementById(`betAmt-${deckId}`).value) || 10.00;
            document.getElementById(`btnSub-${deckId}`).innerText = `${val.toFixed(2)} KES`;
        }
        alert(`Cashed Out Successfully!\nReceived KES ${payout.toFixed(2)}`);
    });

    socket.on('error_message', (msg) => {
        alert(msg);
    });
});

// Window canvas adjustments
function resizeCanvas() {
    if (canvas) {
        canvas.width = canvas.parentElement.clientWidth;
        canvas.height = canvas.parentElement.clientHeight;
        drawInitialGraph();
    }
}

// Draw Graph with Shaded Gradient area matching style in the image
function drawInitialGraph() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Grid Lines Layer
    ctx.strokeStyle = '#1e1e28';
    ctx.lineWidth = 1;
    for (let i = 50; i < canvas.width; i += 60) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, canvas.height);
        ctx.stroke();
    }
    for (let i = 40; i < canvas.height; i += 40) {
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(canvas.width, i);
        ctx.stroke();
    }
}

function resetFlightAnimation() {
    flightProgress = 0;
    currentX = 50;
    currentY = canvas ? canvas.height - 50 : 300;
}

// Render curved flight path with shaded canvas bottom region
function drawFlightCurve(multiplier) {
    if (!ctx || !canvas) return;
    drawInitialGraph();

    flightProgress++;
    
    // Dynamic exponential flight path
    let targetX = 50 + (flightProgress * 1.6);
    let targetY = (canvas.height - 50) - (Math.pow(flightProgress, 1.45) * 0.4);

    // Prevent plane from leaving canvas frame boundaries too early
    if (targetX > canvas.width - 80) targetX = canvas.width - 80;
    if (targetY < 60) targetY = 60;

    currentX = targetX;
    currentY = targetY;

    // 1. Draw Transparent Shaded Area Underneath Curve (Matches Red Shadow in Image)
    ctx.save();
    const fillGradient = ctx.createLinearGradient(50, currentY, 50, canvas.height - 50);
    fillGradient.addColorStop(0, 'rgba(233, 30, 99, 0.4)');
    fillGradient.addColorStop(1, 'rgba(233, 30, 99, 0.0)');
    
    ctx.fillStyle = fillGradient;
    ctx.beginPath();
    ctx.moveTo(50, canvas.height - 50);
    // Draw same curve geometry as stroke
    ctx.quadraticCurveTo(currentX / 2 + 25, canvas.height - 50, currentX, currentY);
    ctx.lineTo(currentX, canvas.height - 50);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 2. Draw Crimson Curved Line Stroke
    ctx.strokeStyle = '#e91e63';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(50, canvas.height - 50);
    ctx.quadraticCurveTo(currentX / 2 + 25, canvas.height - 50, currentX, currentY);
    ctx.stroke();

    // 3. Draw Plane Silhouette Vector
    drawPropellerPlane(ctx, currentX, currentY, 65, 30);
}

// Sync global text multiplier overlays
function updateGameDisplay(state, multiplier, timer = 0) {
    const multView = document.getElementById('multiplierView');
    
    if (state === 'waiting') {
        if (multView) {
            multView.innerHTML = `<span style="font-size: 16px; color: #afb42b; text-transform: uppercase; font-weight: 800; letter-spacing: 1px;">Next Round Active In</span><br><span style="font-size: 52px; font-weight: 900; color: #fff;">${timer}s</span>`;
        }
        drawInitialGraph();
    } else if (state === 'flying') {
        if (multView) {
            multView.innerHTML = `<span style="color: white; font-weight: 900; font-size: 72px;">${multiplier.toFixed(2)}x</span>`;
        }
        drawFlightCurve(multiplier);
    } else if (state === 'crashed') {
        if (multView) {
            multView.innerHTML = `<span style="color: #e91e63; font-weight: 900; font-size: 56px; text-transform: uppercase; text-shadow: 0 0 10px rgba(233, 30, 99, 0.4);">Flew Away!</span><br><span style="color: #888; font-size: 32px; font-weight: 800;">${multiplier.toFixed(2)}x</span>`;
        }
    }
}

// Place Bet or Request Cashout Actions
function executeBetAction(deckId) {
    const inputField = document.getElementById(`betAmt-${deckId}`);
    const actionBtn = document.getElementById(`btnAction-${deckId}`);
    if (!inputField || !actionBtn) return;

    // Check Action Branch (Is betting or Cashing Out)
    if (actionBtn.classList.contains('btn-bet')) {
        // --- Betting Flow ---
        const amount = parseFloat(inputField.value);
        if (isNaN(amount) || amount <= 0) {
            alert('Please specify a valid bet amount.');
            return;
        }
        // Enforce the minimum bet limit of KSH 10
        if (amount < 10) {
            alert('The minimum amount to place a bet is KSH 10.');
            return;
        }
        if (amount > currentBalance) {
            alert('Insufficient balance.');
            return;
        }

        console.log(`Sending place_bet request for ${amount} on deck ${deckId}`);
        // Send validation payload directly to DB server
        socket.emit('place_bet', {
            username: currentUser,
            deckId: deckId,
            amount: amount
        });

    } else if (actionBtn.classList.contains('btn-cashout')) {
        // --- Cashout Flow ---
        if (gameLifecycle !== 'flying') return;
        
        console.log(`Sending cash_out request for deck ${deckId} at ${activeMultiplier}x`);
        socket.emit('cash_out', {
            username: currentUser,
            deckId: deckId,
            multiplier: activeMultiplier
        });
    }
}

// Convert "Waiting bets" into glowing "Cash Out" buttons once round is flying
function updateButtonsOnFlightStart() {
    [1, 2].forEach(deckId => {
        const bet = localBets[deckId];
        // If the bet was placed/active, transition immediately!
        if (bet.active && !bet.cashedOut) {
            const actionBtn = document.getElementById(`btnAction-${deckId}`);
            if (actionBtn) {
                // Instantly update classes and text to Cash Out state
                actionBtn.className = 'main-action-trigger btn-cashout';
                
                const titleElem = document.getElementById(`btnTitle-${deckId}`);
                if (titleElem) titleElem.innerText = 'Cash Out';
                
                const subElem = document.getElementById(`btnSub-${deckId}`);
                if (subElem) {
                    const currentPayout = bet.amount * activeMultiplier;
                    subElem.innerText = `${currentPayout.toFixed(2)} KES`;
                }
            }
        }
    });
}

// Dynamic real-time payout recalculation ticker (triggers on every frame sync)
function updatePayoutTicks() {
    [1, 2].forEach(deckId => {
        const bet = localBets[deckId];
        if (bet.active && !bet.cashedOut) {
            const currentPayout = bet.amount * activeMultiplier;
            const subtitle = document.getElementById(`btnSub-${deckId}`);
            if (subtitle) {
                subtitle.innerText = `${currentPayout.toFixed(2)} KES`;
            }
        }
    });
}

// Clear unpaid bets if plane flies away (crashes)
function handleBetsOnCrash() {
    [1, 2].forEach(deckId => {
        const bet = localBets[deckId];
        if (bet.active && !bet.cashedOut) {
            // Lost Bet
            bet.active = false;
            
            const actionBtn = document.getElementById(`btnAction-${deckId}`);
            if (actionBtn) {
                actionBtn.className = 'main-action-trigger btn-bet';
                document.getElementById(`btnTitle-${deckId}`).innerText = 'Bet';
                const inputVal = parseFloat(document.getElementById(`betAmt-${deckId}`).value) || 10.00;
                document.getElementById(`btnSub-${deckId}`).innerText = `${inputVal.toFixed(2)} KES`;
            }
        }
    });
}

// Restore default options
function resetBettingsUI(lifecycle) {
    [1, 2].forEach(deckId => {
        localBets[deckId].active = false;
        localBets[deckId].cashedOut = false;
        localBets[deckId].amount = 0;
        
        const actionBtn = document.getElementById(`btnAction-${deckId}`);
        if (actionBtn) {
            actionBtn.className = 'main-action-trigger btn-bet';
            document.getElementById(`btnTitle-${deckId}`).innerText = 'Bet';
            const inputVal = parseFloat(document.getElementById(`betAmt-${deckId}`).value) || 10.00;
            document.getElementById(`btnSub-${deckId}`).innerText = `${inputVal.toFixed(2)} KES`;
        }
    });
}

// Authentication Request Handler
function handleAuthSubmit(type) {
    const isLogin = type === 'login';
    const usernameInput = document.getElementById(isLogin ? 'loginUser' : 'regUser');
    const passwordInput = document.getElementById(isLogin ? 'loginPass' : 'regPass');

    if (!usernameInput || !passwordInput) return;

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
        alert('Please complete all form credentials.');
        return;
    }

    const endpoint = isLogin ? '/api/login' : '/api/register';
    
    fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    })
    .then(res => res.json())
    .then(data => {
        if (data.error) {
            alert(data.error);
        } else {
            if (isLogin) {
                currentUser = data.username;
                currentBalance = data.balance;

                // Sync connection session directly to Socket.io to prevent database discrepancies
                if (socket) {
                    socket.emit('register_session', currentUser);
                }
                
                // Update navigation labels safely
                const navUser = document.getElementById('navUser');
                const navBalance = document.getElementById('navBalance');
                const authOverlay = document.getElementById('authOverlay');
                const gameWorkspace = document.getElementById('gameWorkspace');
                const betBtn1 = document.getElementById('btnAction-1');
                const betBtn2 = document.getElementById('btnAction-2');

                if (navUser) navUser.innerText = currentUser;
                if (navBalance) navBalance.innerText = 'KES ' + parseFloat(currentBalance).toFixed(2);
                if (authOverlay) authOverlay.style.display = 'none';
                if (gameWorkspace) gameWorkspace.style.display = 'block';
                if (betBtn1) betBtn1.disabled = false;
                if (betBtn2) betBtn2.disabled = false;
                
                // Refresh Canvas once after entering game
                setTimeout(resizeCanvas, 100);
            } else {
                alert('Registration successful! Please login.');
                toggleAuthView(true);
            }
        }
    })
    .catch(err => {
        console.error('Authentication pipeline failed:', err);
        alert('Failed connecting to server backend network.');
    });
}

// Toggle Auth Screens helper
function toggleAuthView(showLogin) {
    const loginCard = document.getElementById('loginForm');
    const registerCard = document.getElementById('registerForm');
    
    if (loginCard && registerCard) {
        if (showLogin) {
            loginCard.style.display = 'block';
            registerCard.style.display = 'none';
        } else {
            loginCard.style.display = 'none';
            registerCard.style.display = 'block';
        }
    }
}