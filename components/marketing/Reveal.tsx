'use client'
import { useEffect, useRef, useState } from 'react'
import styles from '@/styles/marketing.module.css'

/**
 * Fades and lifts its children into view the first time they cross into the viewport. Children stay server-rendered
 * (they arrive as `children`), so this is the only client boundary the scroll effect needs. Adds `.in`, which also
 * drives the ledger bars in the before/after section. With scripts disabled the stylesheet shows everything
 * (@media (scripting: none)); with reduced motion it reveals immediately.
 */
export default function Reveal({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: React.ReactNode
  className?: string
  as?: 'div' | 'article' | 'figure' | 'section'
}) {
  const ref = useRef<HTMLElement | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || !('IntersectionObserver' in window)) {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setInView(true)
            io.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const Component = Tag as any
  return (
    <Component ref={ref} className={`${styles.reveal} ${inView ? styles.in : ''} ${className}`.trim()}>
      {children}
    </Component>
  )
}
