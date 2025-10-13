export function scrollToSection(id) {
  if (typeof window === 'undefined' || !id) {
    return false
  }

  const element = document.getElementById(id)
  if (!element) {
    return false
  }

  const header = document.querySelector('header')
  const headerOffset = header ? header.offsetHeight : 0
  const elementTop = element.getBoundingClientRect().top + window.scrollY
  const targetPosition = Math.max(elementTop - headerOffset, 0)

  window.scrollTo({ top: targetPosition, behavior: 'smooth' })
  return true
}
