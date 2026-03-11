import './globals.css';
import { ReactNode } from 'react';

export const metadata = {
    title: 'AI Receptionist',
    description: 'Voice & text AI receptionist for hotel and restaurant bookings',
};

interface RootLayoutProps {
    children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
    return (
        <html lang="en" className="scroll-smooth">
            <body className="selection:bg-primary-500/30">
                {children}
            </body>
        </html>
    );
}
