'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import styles from '@/styles/marketing.module.css'

/** Sticky bottom call to action on small screens, shown only once the hero (#hero) has scrolled out of view. */
export default function MobileCta() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const hero = document.getElementById('hero')
    if (!hero || !('IntersectionObserver' in window)) {
      setShow(true)
      return
    }
    const io = new IntersectionObserver((es) => setShow(!es[0].isIntersecting), { threshold: 0 })
    io.observe(hero)
    return () => io.disconnect()
  }, [])

  return (
    <div className={`${styles.mcta} ${show ? styles.show : ''}`.trim()}>
      <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/signup">Start free trial</Link>
      <a className={`${styles.btn} ${styles.btnGhost}`} href="#pricing">My scope leak</a>
    </div>
  )
}
