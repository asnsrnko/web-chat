require('dotenv').config();

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, initDb } = require('./db');

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'webchat-student-secret';
const MAX_HISTORY = 100;

const app = express();
app.use(cors());
app.use(express.json());

function createToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Регистрация нового аккаунта
app.post('/api/register', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    if (!username || username.length > 30) {
      return res.status(400).json({ error: 'Ник должен быть от 1 до 30 символов' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Пароль должен быть не короче 4 символов' });
    }

    const exists = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Такой ник уже занят' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username`,
      [username, passwordHash]
    );

    const user = result.rows[0];
    const token = createToken(user);
    res.status(201).json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

// Вход в существующий аккаунт
app.post('/api/login', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Введите ник и пароль' });
    }

    const result = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный ник или пароль' });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Неверный ник или пароль' });
    }

    const token = createToken(user);
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера при входе' });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch {
    res.status(500).json({ ok: false, db: false });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function getOnlineUsernames() {
  const names = new Set();
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN && client.user) {
      names.add(client.user.username);
    }
  });
  return Array.from(names).sort((a, b) => a.localeCompare(b, 'ru'));
}

function isUserOnline(username, except = null) {
  for (const client of wss.clients) {
    if (
      client !== except &&
      client.readyState === client.OPEN &&
      client.user?.username === username
    ) {
      return true;
    }
  }
  return false;
}

function broadcastOnlineUsers() {
  broadcast({ type: 'users', users: getOnlineUsernames() });
}

function broadcastSystem(text) {
  broadcast({
    type: 'system',
    message: {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      timestamp: new Date().toISOString(),
    },
  });
}

// beforeId — подгрузить сообщения старше этого id; иначе последние MAX_HISTORY
async function loadMessages(beforeId = null) {
  const params = [];
  let whereClause = '';

  if (beforeId !== null && beforeId !== undefined && beforeId !== '') {
    const id = Number(beforeId);
    if (!Number.isInteger(id) || id <= 0) {
      return { messages: [], hasMore: false };
    }
    params.push(id);
    whereClause = `WHERE m.id < $${params.length}`;
  }

  // Берём на 1 больше, чтобы понять, есть ли ещё более старые
  params.push(MAX_HISTORY + 1);
  const limitPlaceholder = `$${params.length}`;

  const result = await pool.query(
    `SELECT m.id, u.username AS author, m.text, m.created_at AS timestamp
     FROM messages m
     JOIN users u ON u.id = m.user_id
     ${whereClause}
     ORDER BY m.id DESC
     LIMIT ${limitPlaceholder}`,
    params
  );

  const hasMore = result.rows.length > MAX_HISTORY;
  const rows = result.rows.slice(0, MAX_HISTORY).reverse();

  return {
    messages: rows.map((row) => ({
      id: String(row.id),
      author: row.author,
      text: row.text,
      timestamp: row.timestamp,
    })),
    hasMore,
  };
}

wss.on('connection', (ws) => {
  ws.user = null;

  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', text: 'Некорректное сообщение' });
      return;
    }

    try {
      if (data.type === 'join') {
        const payload = verifyToken(data.token);
        if (!payload) {
          send(ws, { type: 'error', text: 'Нужно войти в аккаунт' });
          return;
        }

        const alreadyOnline = isUserOnline(payload.username);
        ws.user = { id: payload.userId, username: payload.username };

        const { messages, hasMore } = await loadMessages();
        send(ws, { type: 'history', messages, hasMore });
        send(ws, { type: 'users', users: getOnlineUsernames() });

        if (!alreadyOnline) {
          broadcastSystem(`${payload.username} вошёл в чат`);
          broadcastOnlineUsers();
        }
        return;
      }

      // Подгрузка более старых сообщений (lazy loading)
      if (data.type === 'load_older') {
        if (!ws.user) {
          send(ws, { type: 'error', text: 'Сначала войдите в аккаунт' });
          return;
        }

        const { messages, hasMore } = await loadMessages(data.beforeId);
        send(ws, { type: 'older', messages, hasMore });
        return;
      }

      if (data.type === 'message') {
        if (!ws.user) {
          send(ws, { type: 'error', text: 'Сначала войдите в аккаунт' });
          return;
        }

        const text = (data.text || '').trim();
        if (!text || text.length > 500) {
          send(ws, { type: 'error', text: 'Сообщение должно быть от 1 до 500 символов' });
          return;
        }

        const result = await pool.query(
          `INSERT INTO messages (user_id, text)
           VALUES ($1, $2)
           RETURNING id, text, created_at`,
          [ws.user.id, text]
        );

        const row = result.rows[0];
        const message = {
          id: String(row.id),
          author: ws.user.username,
          text: row.text,
          timestamp: row.created_at,
        };

        broadcast({ type: 'message', message });
        return;
      }

      send(ws, { type: 'error', text: 'Неизвестный тип сообщения' });
    } catch (err) {
      console.error(err);
      send(ws, { type: 'error', text: 'Ошибка сервера' });
    }
  });

  ws.on('close', () => {
    const leftUser = ws.user;
    ws.user = null;

    if (!leftUser) return;

    // Системное сообщение только когда у человека не осталось других вкладок
    if (!isUserOnline(leftUser.username)) {
      broadcastSystem(`${leftUser.username} вышел из чата`);
      broadcastOnlineUsers();
    }
  });
});

async function start() {
  await initDb();
  // 0.0.0.0 — слушать не только localhost, а всю локальную сеть
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    console.log(`В локальной сети: http://<твой-IP>:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Не удалось запустить сервер:', err);
  process.exit(1);
});
