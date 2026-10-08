import { useEffect, useRef, useState } from 'react'
import './App.css'

// На другом устройстве в сети hostname будет IP твоего компьютера, не localhost
const HOST = window.location.hostname
const API_URL = `http://${HOST}:3001`
const WS_URL = `ws://${HOST}:3001`
const STORAGE_KEY = 'webchat_auth'

function formatTime(iso) {
  const date = new Date(iso)
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function loadSavedAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function App() {
  const [auth, setAuth] = useState(() => loadSavedAuth())
  const [mode, setMode] = useState('login') // login | register
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [messages, setMessages] = useState([])
  const [onlineUsers, setOnlineUsers] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [text, setText] = useState('')
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const socketRef = useRef(null)
  const listRef = useRef(null)
  const shouldScrollRef = useRef(true)
  const loadingOlderRef = useRef(false)
  const hasMoreRef = useRef(false)
  const messagesRef = useRef([])
  const pendingScrollRestoreRef = useRef(null)

  // Подключение к WebSocket после входа
  useEffect(() => {
    if (!auth?.token) return

    const socket = new WebSocket(WS_URL)
    socketRef.current = socket

    socket.onopen = () => {
      setConnected(true)
      setError('')
      socket.send(JSON.stringify({ type: 'join', token: auth.token }))
    }

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data)

      if (data.type === 'history') {
        setMessages(data.messages)
        setHasMore(Boolean(data.hasMore))
        shouldScrollRef.current = true
      }

      if (data.type === 'older') {
        setMessages((prev) => {
          const existing = new Set(prev.map((m) => m.id))
          const fresh = (data.messages || []).filter((m) => !existing.has(m.id))
          return [...fresh, ...prev]
        })
        setHasMore(Boolean(data.hasMore))
        loadingOlderRef.current = false
        setLoadingOlder(false)
      }

      if (data.type === 'message') {
        setMessages((prev) => [...prev, data.message])
        shouldScrollRef.current = true
      }

      if (data.type === 'system') {
        setMessages((prev) => [
          ...prev,
          { ...data.message, kind: 'system' },
        ])
        shouldScrollRef.current = true
      }

      if (data.type === 'users') {
        setOnlineUsers(data.users || [])
      }

      if (data.type === 'error') {
        setError(data.text)
        loadingOlderRef.current = false
        setLoadingOlder(false)
      }
    }

    socket.onclose = () => {
      setConnected(false)
      setOnlineUsers([])
      setHasMore(false)
    }

    socket.onerror = () => {
      setError('Не удалось подключиться к серверу')
      setConnected(false)
    }

    return () => {
      socket.close()
    }
  }, [auth])

  useEffect(() => {
    hasMoreRef.current = hasMore
  }, [hasMore])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    const el = listRef.current
    if (!el) return

    // После подгрузки старых — сохранить позицию скролла
    if (pendingScrollRestoreRef.current != null) {
      el.scrollTop = el.scrollHeight - pendingScrollRestoreRef.current
      pendingScrollRestoreRef.current = null
      return
    }

    if (shouldScrollRef.current) {
      el.scrollTop = el.scrollHeight
      shouldScrollRef.current = false
    }
  }, [messages])

  function handleMessagesScroll() {
    const el = listRef.current
    if (!el) return
    if (el.scrollTop > 40) return
    if (!hasMoreRef.current || loadingOlderRef.current) return
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return

    const oldest = messagesRef.current.find((m) => m.kind !== 'system')
    if (!oldest) return

    loadingOlderRef.current = true
    setLoadingOlder(true)
    pendingScrollRestoreRef.current = el.scrollHeight
    socketRef.current.send(
      JSON.stringify({ type: 'load_older', beforeId: oldest.id })
    )
  }

  async function handleAuthSubmit(e) {
    e.preventDefault()
    const nick = username.trim()
    if (!nick || !password) {
      setError('Введите ник и пароль')
      return
    }

    setLoading(true)
    setError('')

    try {
      const endpoint = mode === 'register' ? '/api/register' : '/api/login'
      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: nick, password }),
      })
      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Не удалось выполнить запрос')
        return
      }

      const nextAuth = { token: data.token, user: data.user }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextAuth))
      setAuth(nextAuth)
      setPassword('')
    } catch {
      setError('Сервер недоступен. Запущен ли backend?')
    } finally {
      setLoading(false)
    }
  }

  function handleLogout() {
    localStorage.removeItem(STORAGE_KEY)
    setAuth(null)
    setMessages([])
    setOnlineUsers([])
    setHasMore(false)
    setLoadingOlder(false)
    loadingOlderRef.current = false
    setConnected(false)
    setError('')
  }

  function handleSend(e) {
    e.preventDefault()
    const value = text.trim()
    if (!value || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      return
    }
    socketRef.current.send(JSON.stringify({ type: 'message', text: value }))
    setText('')
  }

  if (!auth) {
    return (
      <div className="page">
        <form className="login" onSubmit={handleAuthSubmit}>
          <h1>Web Chat</h1>
          <p>
            {mode === 'register'
              ? 'Создайте аккаунт: придумайте ник и пароль'
              : 'Войдите по нику и паролю'}
          </p>

          <div className="tabs">
            <button
              type="button"
              className={mode === 'login' ? 'tab active' : 'tab'}
              onClick={() => {
                setMode('login')
                setError('')
              }}
            >
              Вход
            </button>
            <button
              type="button"
              className={mode === 'register' ? 'tab active' : 'tab'}
              onClick={() => {
                setMode('register')
                setError('')
              }}
            >
              Регистрация
            </button>
          </div>

          <input
            type="text"
            placeholder="Ник"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={30}
            autoFocus
            autoComplete="username"
          />
          <input
            type="password"
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          />
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={loading}>
            {loading
              ? 'Подождите...'
              : mode === 'register'
                ? 'Создать аккаунт'
                : 'Войти'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="chat">
        <header className="chat-header">
          <div>
            <h1>Web Chat</h1>
            <span className="subtitle">Вы: {auth.user.username}</span>
          </div>
          <div className="header-actions">
            <span className={`status ${connected ? 'online' : 'offline'}`}>
              {connected ? 'онлайн' : 'офлайн'}
            </span>
            <button type="button" className="logout" onClick={handleLogout}>
              Выйти
            </button>
          </div>
        </header>

        <div className="chat-body">
          <div
            className="messages"
            ref={listRef}
            onScroll={handleMessagesScroll}
          >
            {loadingOlder && (
              <p className="history-hint">Загрузка старых сообщений...</p>
            )}
            {!loadingOlder && hasMore && messages.length > 0 && (
              <p className="history-hint">Прокрутите вверх, чтобы загрузить ещё</p>
            )}
            {!hasMore && messages.some((m) => m.kind !== 'system') && (
              <p className="history-hint">Это начало переписки</p>
            )}
            {messages.length === 0 && (
              <p className="empty">Сообщений пока нет — напишите первым!</p>
            )}
            {messages.map((msg) => {
              if (msg.kind === 'system') {
                return (
                  <div key={msg.id} className="system-message">
                    {msg.text}
                  </div>
                )
              }

              const isMine = msg.author === auth.user.username
              return (
                <div
                  key={msg.id}
                  className={`message ${isMine ? 'mine' : ''}`}
                >
                  <div className="message-meta">
                    <strong>{msg.author}</strong>
                    <span>{formatTime(msg.timestamp)}</span>
                  </div>
                  <p>{msg.text}</p>
                </div>
              )
            })}
          </div>

          <aside className="online-panel">
            <h2>Онлайн ({onlineUsers.length})</h2>
            {onlineUsers.length === 0 ? (
              <p className="online-empty">Никого нет</p>
            ) : (
              <ul>
                {onlineUsers.map((name) => (
                  <li key={name}>
                    <span className="dot" />
                    {name}
                    {name === auth.user.username ? ' (вы)' : ''}
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>

        {error && <p className="error chat-error">{error}</p>}

        <form className="composer" onSubmit={handleSend}>
          <input
            type="text"
            placeholder="Введите сообщение..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
            disabled={!connected}
          />
          <button type="submit" disabled={!connected || !text.trim()}>
            Отправить
          </button>
        </form>
      </div>
    </div>
  )
}

export default App
