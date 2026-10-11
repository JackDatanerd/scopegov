'use client'
import { useEffect, useRef, useState } from 'react'

/** Counts up to `target` the first time it is mostly in view. The final value is what the server renders (the no-JS / reduced-motion result). */
export default function CountUp({ target, prefix = '', suffix = '' }: { target: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const fmt = (v: number) => prefix + Math.round(v).toLocaleString('en-US') + suffix
  const [text, setText] = useState(fmt(target))

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || !('IntersectionObserver' in window)) return
    let raf = 0
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        io.disconnect()
        const dur = 1500
        let t0: number | null = null
        setText(fmt(0))
        const step = (ts: number) => {
          if (t0 === null) t0 = ts
          const p = Math.min(1, (ts - t0) / dur)
          const eased = 1 - Math.pow(1 - p, 3)
          setText(fmt(target * eased))
          if (p < 1) raf = requestAnimationFrame(step)
          else setText(fmt(target))
        }
        raf = requestAnimationFrame(step)
      },
      { threshold: 0.6 }
    )
    io.observe(el)
    return () => {
      io.disconnect()
      cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, prefix, suffix])

  return <span ref={ref}>{text}</span>
}
