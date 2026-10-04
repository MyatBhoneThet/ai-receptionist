'use client';

import { useState, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend
} from 'recharts';
import { Users, CalendarCheck, XCircle, Grid, Clock, Activity } from 'lucide-react';
import { getAnalyticsSummary, getAnalyticsTimeseries, getRecentBookings } from '../../lib/api';

interface SummaryData {
  total_bookings: number;
  today_bookings: number;
  cancellations: number;
  by_service: {
    restaurant: number;
    hotel: number;
    meeting: number;
  };
}

interface TimeseriesData {
  date: string;
  bookings: number;
}

interface RecentBooking {
  id: number;
  service_type: string;
  reservation_name: string;
  date: string;
  start_time: string;
  people: number;
  status: string;
  created_at: string;
}

export default function Dashboard() {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesData[]>([]);
  const [recent, setRecent] = useState<RecentBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchDashboardData = async () => {
      setLoading(true);
      setError('');
      try {
        const storedToken = window.localStorage.getItem('ai_receptionist_auth_token')
          || window.sessionStorage.getItem('ai_receptionist_admin_token')
          || undefined;

        const [summaryData, timeseriesData, recentData] = await Promise.all([
          getAnalyticsSummary(storedToken),
          getAnalyticsTimeseries(storedToken),
          getRecentBookings(storedToken),
        ]);

        setSummary(summaryData as SummaryData);
        setTimeseries(timeseriesData as TimeseriesData[]);
        setRecent(recentData as RecentBooking[]);
      } catch (err) {
        console.error('Failed to fetch dashboard data:', err);
        setSummary(null);
        setTimeseries([]);
        setRecent([]);
        setError('Analytics access denied or backend unavailable.');
      } finally {
        setLoading(false);
      }
    };

    fetchDashboardData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950 text-white">
        <div className="flex flex-col items-center space-y-4">
          <Activity className="w-12 h-12 text-primary-500 animate-spin" />
          <p className="text-lg font-medium">Loading Dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-white">
        <div className="w-full max-w-md rounded-3xl border border-rose-500/20 bg-slate-900/70 p-8 shadow-2xl">
          <h1 className="text-2xl font-semibold">Dashboard Unavailable</h1>
          <p className="mt-2 text-sm text-slate-400">{error}</p>
          <button
            className="mt-6 rounded-2xl bg-white/10 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/20"
            onClick={() => {
              setError('');
              setLoading(true);
              window.location.reload();
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const serviceData = summary ? [
    { name: 'Restaurant', value: summary.by_service.restaurant, fill: '#8b5cf6' },
    { name: 'Hotel', value: summary.by_service.hotel, fill: '#3b82f6' },
    { name: 'Meeting', value: summary.by_service.meeting, fill: '#10b981' },
  ] : [];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans selection:bg-primary-500/30">
      {/* Navbar area */}
      <nav className="border-b border-primary-500/20 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-gradient-to-r from-primary-600 to-primary-400 flex items-center justify-center shadow-lg shadow-primary-500/20">
                <Activity className="w-5 h-5 text-white" />
              </div>
              <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">
                AI Receptionist Manager
              </span>
            </div>
            <div className="text-sm font-medium text-slate-400">
              Live Overview
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        
        {/* Top Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatCard 
            title="Total Active Bookings" 
            value={summary?.total_bookings.toString() || '0'} 
            icon={<CalendarCheck className="w-6 h-6 text-primary-400" />} 
            trend="+12% from last week" 
            trendPositive={true}
          />
          <StatCard 
            title="Today's Bookings" 
            value={summary?.today_bookings.toString() || '0'} 
            icon={<Clock className="w-6 h-6 text-emerald-400" />} 
            trend="Needs Attention" 
            trendPositive={true}
          />
          <StatCard 
            title="Total Cancellations" 
            value={summary?.cancellations.toString() || '0'} 
            icon={<XCircle className="w-6 h-6 text-rose-400" />} 
            trend="-2% from last week" 
            trendPositive={true}
          />
          <StatCard 
            title="Total Guests Expected" 
            value={(summary?.total_bookings ? summary.total_bookings * 2 : 0).toString()} 
            icon={<Users className="w-6 h-6 text-blue-400" />} 
            trend="Estimate based on avg" 
            trendPositive={true}
          />
        </div>

        {/* Charts Section */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Trend Chart */}
          <div className="col-span-1 lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl relative overflow-hidden group">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary-600 to-primary-400" />
            <h3 className="text-lg font-semibold text-white mb-6 flex items-center gap-2">
              <Grid className="w-5 h-5 text-primary-500" />
              Booking Trends (Last 7 Days)
            </h3>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={timeseries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                  <XAxis 
                    dataKey="date" 
                    stroke="#94a3b8" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <YAxis 
                    stroke="#94a3b8" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px' }}
                    itemStyle={{ color: '#e2e8f0' }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="bookings" 
                    stroke="#8b5cf6" 
                    strokeWidth={3} 
                    dot={{ fill: '#8b5cf6', strokeWidth: 2, r: 4 }} 
                    activeDot={{ r: 6, strokeWidth: 0 }}
                    animationDuration={1500}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Service Distribution Chart */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 to-emerald-400" />
            <h3 className="text-lg font-semibold text-white mb-6">Service Distribution</h3>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={serviceData} layout="vertical" margin={{ top: 0, right: 0, left: 20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                  <XAxis type="number" stroke="#94a3b8" fontSize={12} hide />
                  <YAxis dataKey="name" type="category" stroke="#94a3b8" fontSize={12} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: '#1e293b' }}
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px' }}
                  />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} animationDuration={1500} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Recent Activity Table */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
          <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
            <h3 className="text-lg font-semibold text-white">Recent Activity</h3>
            <button className="text-sm text-primary-400 hover:text-primary-300 transition-colors font-medium">View All</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-800/50">
                  <th className="p-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">Service</th>
                  <th className="p-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">Name</th>
                  <th className="p-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">Date & Time</th>
                  <th className="p-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">Guests</th>
                  <th className="p-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {recent.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-slate-500 italic">No recent bookings found.</td>
                  </tr>
                ) : (
                  recent.map((booking) => (
                    <tr key={booking.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="p-4">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-300 border border-slate-700 capitalize">
                          {booking.service_type === 'restaurant' ? '🍽️' : booking.service_type === 'hotel' ? '🏨' : '🤝'} {booking.service_type}
                        </span>
                      </td>
                      <td className="p-4 font-medium text-white">{booking.reservation_name || 'Anonymous'}</td>
                      <td className="p-4 text-slate-400">
                        {formatDateValue(booking.date)} {booking.start_time ? `at ${booking.start_time}` : ''}
                      </td>
                      <td className="p-4 text-slate-400">{booking.people || '-'}</td>
                      <td className="p-4">
                        <StatusBadge status={booking.status} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </main>
    </div>
  );
}

function formatDateValue(value: any) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    const yyyy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, '0');
    const dd = String(value.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return String(value).slice(0, 10);
}

function StatCard({ title, value, icon, trend, trendPositive }: { title: string, value: string, icon: React.ReactNode, trend: string, trendPositive: boolean }) {
  return (
    <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-lg hover:border-primary-500/50 transition-colors group relative overflow-hidden">
      <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity transform group-hover:scale-110 group-hover:rotate-12 duration-500">
        <div className="w-16 h-16">{icon}</div>
      </div>
      <div className="flex justify-between items-start mb-4 relative z-10">
        <h4 className="text-sm font-medium text-slate-400">{title}</h4>
        <div className="p-2 bg-slate-800 rounded-lg">{icon}</div>
      </div>
      <div className="relative z-10">
        <div className="text-3xl font-bold text-white mb-2">{value}</div>
        <div className={`text-xs font-medium ${trendPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
          {trend}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    confirmed: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    cancelled: 'bg-rose-500/10 text-rose-500 border-rose-500/20',
    modified: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  };

  const style = styles[status] || 'bg-slate-500/10 text-slate-500 border-slate-500/20';

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border capitalize ${style}`}>
      {status}
    </span>
  );
}
