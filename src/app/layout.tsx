import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Soundboard",
  description: "A personal soundboard — multiple boards, each with pages of tap-to-play sound pads.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
