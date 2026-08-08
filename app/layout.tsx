import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "交易驾驶舱｜看盘、组合风险与复盘规则",
  description:
    "统一 TradingView 看盘、长桥真实仓位与历史成交，由交易 Agent 管理组合暴露，并建立复盘、测试、规则与人工 Review 闭环。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "交易驾驶舱｜看盘、组合风险与复盘规则",
    description: "TradingView 看盘、长桥真实账户、Codex Agent 与可验证复盘闭环。",
    type: "website",
    locale: "zh_CN",
    images: [{
      url: "/trading-cockpit-og.png",
      width: 1731,
      height: 909,
      alt: "交易驾驶舱的组合风险、市场证据与复盘闭环",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "交易驾驶舱｜看盘、组合风险与复盘规则",
    description: "TradingView 看盘、长桥真实账户、Codex Agent 与可验证复盘闭环。",
    images: ["/trading-cockpit-og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
