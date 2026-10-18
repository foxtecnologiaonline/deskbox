import { useEffect, useRef, useState } from 'react'
import { setToastListener } from '../toast'

export default function ToastHost(): JSX.Element | null {
  const [message, setMessage] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    setToastListener((msg) => {
      setMessage(msg)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => setMessage(null), 3000)
    })
    return () => setToastListener(null)
  }, [])

  if (!message) return null
  return (
    <div className="toast" role="status">
      {message}
    </div>
  )
}
