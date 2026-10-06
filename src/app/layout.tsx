import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Talk to a Document",
  description: "Hold a live voice conversation with an uploaded PDF or a YouTube video transcript.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Mobile-first target is ~390px. `viewport-fit` keeps content clear of the
  // notch and home indicator on iOS.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f172a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-white text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-50">
        {children}
      </body>
    </html>
  );
}
