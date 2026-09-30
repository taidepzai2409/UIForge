import { useState } from 'react'
import { useEditor } from '@/store/editor'

/** Non-blocking notification panel (replaces modal dialogs for import warnings etc.). */
export function NoticePanel(): React.JSX.Element | null {
  const notice = useEditor((s) => s.notice)
  const setNotice = useEditor((s) => s.setNotice)
  const [copied, setCopied] = useState(false)
  if (!notice) return null
  const all = notice.lines.join('\n')
  const copy = async (): Promise<void> => {
    try {
      await window.api.copyText(all)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      console.warn('copy failed', e)
    }
  }
  return (
    <div className={`notice ${notice.kind}`}>
      <div className="notice-head">
        <span>{notice.title}</span>
        <button className="mini" title="Copy toàn bộ vào clipboard" onClick={() => void copy()}>
          {copied ? 'Đã copy ✓' : 'Copy'}
        </button>
        <button className="mini" title="Đóng" onClick={() => setNotice(null)}>
          ✕
        </button>
      </div>
      <textarea className="notice-body" readOnly value={all} spellCheck={false} />
    </div>
  )
}
