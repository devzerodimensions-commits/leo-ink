import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';

import LoginPage from './pages/Login';
import RegisterPage from './pages/Register';
import DashboardPage from './pages/Dashboard';

import SetupPage from './pages/setup/Setup';
import UsersPage from './pages/setup/Users';

import CustomersPage from './pages/masters/Customers';
import MaterialsPage from './pages/masters/Materials';
import RateCardsPage from './pages/masters/RateCards';

import EnquiriesPage from './pages/crm/Enquiries';
import FollowUpsPage from './pages/crm/FollowUps';

import QuotesPage from './pages/quotes/Quotes';
import QuoteBuilderPage from './pages/quotes/QuoteBuilder';
import QuoteViewPage from './pages/quotes/QuoteView';

import BoardPage from './pages/production/Board';
import JobcardsPage from './pages/production/Jobcards';
import JobBagPage from './pages/production/JobBag';
import MyJobsPage from './pages/production/MyJobs';
import ScanPage from './pages/production/Scan';

function Protected({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Spinner label="Signing you in…" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  const { session, loading } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={session && !loading ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/register" element={session && !loading ? <Navigate to="/" replace /> : <RegisterPage />} />

      <Route path="/" element={<Protected><DashboardPage /></Protected>} />

      <Route path="/setup" element={<Protected><SetupPage /></Protected>} />
      <Route path="/setup/users" element={<Protected><UsersPage /></Protected>} />

      <Route path="/customers" element={<Protected><CustomersPage /></Protected>} />
      <Route path="/materials" element={<Protected><MaterialsPage /></Protected>} />
      <Route path="/rate-cards" element={<Protected><RateCardsPage /></Protected>} />

      <Route path="/enquiries" element={<Protected><EnquiriesPage /></Protected>} />
      <Route path="/follow-ups" element={<Protected><FollowUpsPage /></Protected>} />

      <Route path="/quotes" element={<Protected><QuotesPage /></Protected>} />
      <Route path="/quotes/new" element={<Protected><QuoteBuilderPage /></Protected>} />
      <Route path="/quotes/:id/edit" element={<Protected><QuoteBuilderPage /></Protected>} />
      <Route path="/quotes/:id" element={<Protected><QuoteViewPage /></Protected>} />

      <Route path="/board" element={<Protected><BoardPage /></Protected>} />
      <Route path="/jobcards" element={<Protected><JobcardsPage /></Protected>} />
      <Route path="/jobcards/:id" element={<Protected><JobBagPage /></Protected>} />
      <Route path="/my-jobs" element={<Protected><MyJobsPage /></Protected>} />
      <Route path="/scan" element={<Protected><ScanPage /></Protected>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
