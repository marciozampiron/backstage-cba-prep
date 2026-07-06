import './globals.css';

export const metadata = {
  title: 'CBA Study Coach',
  description:
    'Certified Backstage Associate practice — source-grounded drills, deterministic progress.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <a className="brand" href="/">
              CBA Study Coach
            </a>
            <span className="exam-chip">Certified Backstage Associate</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
