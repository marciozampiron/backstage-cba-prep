import './globals.css';
import AuthGate from './components/AuthGate.js';

export const metadata = {
  title: 'CBA Study Coach',
  description:
    'Certified Backstage Associate practice — source-grounded drills, deterministic progress.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
