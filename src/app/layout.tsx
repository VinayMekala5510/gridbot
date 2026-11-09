import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gridbot — Multi-bot grid trading",
  description: "Configure, run and monitor multiple grid trading bots.",
};

// Runs before the page paints so the saved (or system) theme shows without a flash.
const themeScript = `(function(){try{var t=localStorage.getItem("gridbot.theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
