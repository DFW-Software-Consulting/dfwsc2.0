import { useEffect, useRef, useState } from 'react'

const CHAT_SRC = 'https://support.dfwsc.com/assets/chat/chat-no-jquery.min.js'

export default function ZammadChat() {
  const [isReady, setIsReady] = useState(false)
  const chatRef = useRef(null)

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined
    }

    const existingScript = document.querySelector(`script[src="${CHAT_SRC}"]`)

    const initChat = () => {
      if (window.ZammadChat && !window.__dfwscZammadChatInit) {
        window.__dfwscZammadChatInit = true
        const target = document.getElementById('zammad-chat-root')
        chatRef.current = new window.ZammadChat({
          fontSize: '12px',
          chatId: 2,
          debug: true,
          show: false,
          buttonClass: 'open-zammad-chat',
          inactiveClass: 'is-inactive',
          ...(target ? { target } : {}),
        })
      }
    }

    if (existingScript) {
      if (existingScript.dataset.loaded === 'true') {
        initChat()
      } else {
        existingScript.addEventListener('load', initChat, { once: true })
      }
      return undefined
    }

    const script = document.createElement('script')
    script.src = CHAT_SRC
    script.async = true
    script.dataset.loaded = 'false'
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true'
      initChat()
    })
    document.body.appendChild(script)

    return () => {
      if (script.parentNode) {
        script.parentNode.removeChild(script)
      }
    }
  }, [])

  useEffect(() => {
    const button = document.querySelector('.open-zammad-chat')
    if (!button) {
      return undefined
    }

    const updateState = () => {
      setIsReady(!button.classList.contains('is-inactive'))
    }

    updateState()
    const observer = new MutationObserver(updateState)
    observer.observe(button, { attributes: true, attributeFilter: ['class'] })

    return () => observer.disconnect()
  }, [])

  const handleOpenChat = () => {
    if (!isReady) {
      return
    }

    if (chatRef.current?.open) {
      chatRef.current.open()
      return
    }

    if (chatRef.current?.toggle) {
      chatRef.current.toggle()
    }
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      <button
        type="button"
        className="open-zammad-chat rounded-full bg-brand-500 px-5 py-3 text-sm font-semibold text-white shadow-[0_20px_40px_-18px_rgba(11,114,133,0.6)] transition duration-200 hover:-translate-y-0.5 hover:bg-brand-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
        onClick={handleOpenChat}
        aria-disabled={!isReady}
      >
        Chat with us
      </button>
      <span className="text-xs font-medium text-slate-300">
        {isReady ? 'Chat online' : 'Chat offline'}
      </span>
      <div id="zammad-chat-root" />
    </div>
  )
}
