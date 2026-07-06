'use client';
// App shell matching the Stitch prototype: 260px sidebar + top tab bar on desktop; navy top bar +
// bottom tab bar on mobile. Surfaces outside slice 1 render disabled with a "Soon" marker.
import { usePathname } from 'next/navigation';
import {
  GridIcon,
  BookIcon,
  ClockIcon,
  RefreshIcon,
  ChatIcon,
  TrendIcon,
  GearIcon,
  BellIcon,
  HelpIcon,
} from './icons.js';

const NAV = [
  { label: 'Dashboard', href: '/', prefix: null, icon: GridIcon },
  { label: 'Practice', href: '/practice/setup', prefix: '/practice', icon: BookIcon },
  { label: 'Mock Exam', href: '/mock', prefix: '/mock', icon: ClockIcon },
  { label: 'Review', href: '/review', prefix: '/review', icon: RefreshIcon },
  { label: 'Coach', icon: ChatIcon },
  { label: 'Progress', icon: TrendIcon },
];

function isActive(pathname, href, prefix) {
  if (!href) return false;
  if (href === '/') return pathname === '/';
  return prefix ? pathname.startsWith(prefix) : pathname === href;
}

export default function Shell({ children }) {
  const pathname = usePathname();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-mark">C</div>
          <div>
            <div className="logo-name">CBA Coach</div>
            <div className="logo-sub">Exam Prep</div>
          </div>
        </div>
        <nav className="nav" aria-label="Primary">
          {NAV.map(({ label, href, prefix, icon: Icon }) =>
            href ? (
              <a
                key={label}
                className={`nav-item ${isActive(pathname, href, prefix) ? 'active' : ''}`}
                href={href}
              >
                <Icon /> {label}
              </a>
            ) : (
              <span key={label} className="nav-item disabled" aria-disabled="true">
                <Icon /> {label} <span className="soon">SOON</span>
              </span>
            ),
          )}
        </nav>
        <div className="nav-footer">
          <span className="nav-item disabled" aria-disabled="true">
            <GearIcon /> Settings <span className="soon">SOON</span>
          </span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <nav className="top-tabs" aria-label="Sections">
            <a className={`top-tab ${pathname === '/' ? 'active' : ''}`} href="/">
              Dashboard
            </a>
            <a
              className={`top-tab ${pathname.startsWith('/practice') ? 'active' : ''}`}
              href="/practice/setup"
            >
              Practice
            </a>
            <a className={`top-tab ${pathname.startsWith('/mock') ? 'active' : ''}`} href="/mock">
              Mock Exam
            </a>
          </nav>
          <div className="top-right">
            <BellIcon />
            <HelpIcon />
            <span>Hello, Learner</span>
            <span className="avatar">L</span>
          </div>
        </header>

        <header className="m-topbar">
          <div className="logo-mark">C</div>
          <div>
            <div className="m-title">CBA Study Coach</div>
            <div className="m-sub">Hello, Learner</div>
          </div>
        </header>

        <div className="content">{children}</div>
        <p className="footnote">ⓘ Review explanations cite backstage.io/docs sources.</p>
      </div>

      <nav className="bottom-tabs" aria-label="Primary mobile">
        <a className={`b-tab ${pathname === '/' ? 'active' : ''}`} href="/">
          <GridIcon width={20} height={20} /> Dashboard
        </a>
        <a className={`b-tab ${pathname.startsWith('/practice') ? 'active' : ''}`} href="/practice/setup">
          <BookIcon width={20} height={20} /> Practice
        </a>
        <a className={`b-tab ${pathname.startsWith('/mock') ? 'active' : ''}`} href="/mock">
          <ClockIcon width={20} height={20} /> Mock
        </a>
        <a className={`b-tab ${pathname.startsWith('/review') ? 'active' : ''}`} href="/review">
          <RefreshIcon width={20} height={20} /> Review
        </a>
        <span className="b-tab" aria-disabled="true">
          <ChatIcon width={20} height={20} /> Coach
        </span>
      </nav>
    </div>
  );
}
