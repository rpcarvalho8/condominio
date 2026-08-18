import { Route, Switch } from "wouter";
import { Layout } from "./components/Layout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import LoginPage from "./pages/login";
import PortalPage from "./pages/portal";
import DashboardPage from "./pages/index";
import FracoesPage from "./pages/fracoes";
import QuotasPage from "./pages/quotas";
import DespesasPage from "./pages/despesas";
import MorososPage from "./pages/morosos";
import FornecedoresPage from "./pages/fornecedores";
import RecibosPage from "./pages/recibos";
import DefinicoesPage from "./pages/definicoes";
import UtilizadoresPage from "./pages/utilizadores";
import QuotaTiposPage from "./pages/quota-tipos";
import ImportarPage from "./pages/importar";
import RelatoriosPage from "./pages/relatorios";
import MovimentosBancariosPage from "./pages/movimentos-bancarios";
import AtasPage from "./pages/atas";
import ReunioesPage from "./pages/reunioes";

export default function App() {
  return (
    <Switch>
      {/* Public */}
      <Route path="/login" component={LoginPage} />

      {/* Condómino portal — own layout */}
      <Route path="/portal">
        <ProtectedRoute>
          <PortalPage />
        </ProtectedRoute>
      </Route>

      {/* Admin area — sidebar layout */}
      <Route>
        <ProtectedRoute adminOnly>
          <Layout>
            <Switch>
              <Route path="/" component={DashboardPage} />
              <Route path="/fracoes" component={FracoesPage} />
              <Route path="/quotas" component={QuotasPage} />
              <Route path="/despesas" component={DespesasPage} />
              <Route path="/morosos" component={MorososPage} />
              <Route path="/fornecedores" component={FornecedoresPage} />
              <Route path="/recibos" component={RecibosPage} />
              <Route path="/definicoes" component={DefinicoesPage} />
              <Route path="/utilizadores">
                <ProtectedRoute adminOnly>
                  <UtilizadoresPage />
                </ProtectedRoute>
              </Route>
              <Route path="/quota-tipos" component={QuotaTiposPage} />
              <Route path="/importar" component={ImportarPage} />
              <Route path="/relatorios" component={RelatoriosPage} />
              <Route path="/movimentos-bancarios" component={MovimentosBancariosPage} />
              <Route path="/atas" component={AtasPage} />
              <Route path="/reunioes" component={ReunioesPage} />
            </Switch>
          </Layout>
        </ProtectedRoute>
      </Route>
    </Switch>
  );
}
