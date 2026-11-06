import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gridbot — Multi-bot grid trading",
  description: "Configure, run and monitor multiple grid trading bots.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
