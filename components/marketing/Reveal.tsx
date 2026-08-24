'use client'
import { useEffect, useRef, useState } from 'react'
import styles from '@/styles/marketing.module.css'

/**
 * Fades and lifts its children into view the first time they cross into the
 * viewport. Server-rendered children pass straight through as `children`,
 * so this stays the only client boundary needed for the scroll effect —
 * everything it wraps can remain a server component.
 */
export default function Reveal({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: React.ReactNode
  className?: string
  as?: keyof JSX.IntrinsicElements
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!('IntersectionObserver' in window)) {
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
      { threshold: 0.12 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const Component = Tag as any
  return (
    <Component
      ref={ref}
      className={`${styles.reveal} ${inView ? styles.revealIn : ''} ${className}`}
    >
      {children}
    </Component>
  )
}
