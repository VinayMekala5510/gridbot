import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Gridbot | Strategy Lab", description: "Grid strategy simulator" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
