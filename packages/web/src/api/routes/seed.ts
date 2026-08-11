import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";

// ===================================================================
// DADOS DEMO — Condomínio (seed fictício para desenvolvimento)
// Frações, permilagens e proprietários fictícios (estrutura preservada)
// Total permilagem: 1000‰
// ===================================================================

const FRACOES_SEED = [
  // APARTAMENTOS — Entrada 21
  { numero: "J",  tipo: "apartamento", proprietarioNome: "João Silva",                        permilagem: 38.80, quotaMensal: 39.68 },
  { numero: "L",  tipo: "apartamento", proprietarioNome: "Maria Santos",                      permilagem: 41.76, quotaMensal: 42.71 },
  { numero: "M",  tipo: "apartamento", proprietarioNome: "Ana Costa",                         permilagem: 39.50, quotaMensal: 40.40 },
  { numero: "N",  tipo: "apartamento", proprietarioNome: "Pedro Oliveira",                    permilagem: 38.82, quotaMensal: 39.70 },
  { numero: "O",  tipo: "apartamento", proprietarioNome: "Carlos Ferreira",                   permilagem: 41.76, quotaMensal: 42.71 },
  { numero: "P",  tipo: "apartamento", proprietarioNome: "Sofia Rodrigues",                   permilagem: 43.30, quotaMensal: 44.28 },
  { numero: "Q",  tipo: "apartamento", proprietarioNome: "Miguel Almeida",                    permilagem: 37.14, quotaMensal: 37.98 },
  { numero: "R",  tipo: "apartamento", proprietarioNome: "Beatriz Pereira",                   permilagem: 56.75, quotaMensal: 58.04 },
  { numero: "S",  tipo: "apartamento", proprietarioNome: "Inês Carvalho",                     permilagem: 32.34, quotaMensal: 33.07 },
  { numero: "T",  tipo: "apartamento", proprietarioNome: "Tiago Martins",                     permilagem: 38.50, quotaMensal: 39.37 },
  { numero: "U",  tipo: "apartamento", proprietarioNome: "Catarina Lopes",                    permilagem: 57.21, quotaMensal: 58.51 },
  { numero: "V",  tipo: "apartamento", proprietarioNome: "Admin Demo",                        permilagem: 34.05, quotaMensal: 34.82 },
  { numero: "X",  tipo: "apartamento", proprietarioNome: "Ricardo Nunes",                     permilagem: 39.12, quotaMensal: 40.01 },
  // APARTAMENTOS — Entrada 37
  { numero: "Z",  tipo: "apartamento", proprietarioNome: "Helena Dias",                       permilagem: 55.15, quotaMensal: 56.40 },
  { numero: "AA", tipo: "apartamento", proprietarioNome: "Olivia Mendes",                     permilagem: 35.06, quotaMensal: 35.86 },
  { numero: "AB", tipo: "apartamento", proprietarioNome: "António Rocha",                    permilagem: 35.00, quotaMensal: 35.79 },
  { numero: "AE", tipo: "apartamento", proprietarioNome: "Luís Barbosa",                      permilagem: 37.00, quotaMensal: 37.84 },
  { numero: "AF", tipo: "apartamento", proprietarioNome: "Rui Fernandes",                     permilagem: 35.21, quotaMensal: 36.01 },
  { numero: "AG", tipo: "apartamento", proprietarioNome: "João Dias",                         permilagem: 35.41, quotaMensal: 36.21 },
  { numero: "AH", tipo: "apartamento", proprietarioNome: "Madalena Ramos",                    permilagem: 40.96, quotaMensal: 41.89 },
  // APARTAMENTOS — Entrada 39
  { numero: "AI", tipo: "apartamento", proprietarioNome: "André Sousa",                       permilagem: 35.85, quotaMensal: 36.66 },
  { numero: "AJ", tipo: "apartamento", proprietarioNome: "Mariana Reis",                      permilagem: 34.57, quotaMensal: 35.35 },
  // LOJAS
  { numero: "G",  tipo: "loja",        proprietarioNome: "Loja Demo Unipessoal Lda",          permilagem: 22.96, quotaMensal: 23.49 },
  { numero: "H",  tipo: "loja",        proprietarioNome: "Paula Mendes",                      permilagem: 16.96, quotaMensal: 9.08 },
  { numero: "I",  tipo: "loja",        proprietarioNome: "Paula Mendes",                      permilagem: 22.00, quotaMensal: 11.51 },
  { numero: "AC", tipo: "loja",        proprietarioNome: "Fátima Gomes",                      permilagem: 18.10, quotaMensal: 9.47 },
  { numero: "AD", tipo: "loja",        proprietarioNome: "Comércio Demo Unipessoal Lda",      permilagem: 18.68, quotaMensal: 9.78 },
  // GARAGEM
  { numero: "A",  tipo: "garagem",     proprietarioNome: "Garagem Demo SA",                   permilagem: 2.89,  quotaMensal: 1.51 },
  { numero: "B",  tipo: "garagem",     proprietarioNome: "Luís Barbosa",                      permilagem: 2.86,  quotaMensal: 1.50 },
  { numero: "C",  tipo: "garagem",     proprietarioNome: "Garagem Demo SA",                   permilagem: 2.89,  quotaMensal: 1.51 },
  { numero: "D",  tipo: "garagem",     proprietarioNome: "Tiago Martins",                     permilagem: 3.15,  quotaMensal: 1.65 },
  { numero: "E",  tipo: "garagem",     proprietarioNome: "Bruno Vieira",                      permilagem: 3.00,  quotaMensal: 1.57 },
  { numero: "F",  tipo: "garagem",     proprietarioNome: "Bruno Vieira",                      permilagem: 3.25,  quotaMensal: 1.70 },
];

const FORNECEDORES_SEED = [
  { nome: "Indaqua Santo Tirso",        categoria: "agua",           nif: null, email: null, telefone: null, avaliacao: 3.5 },
  { nome: "SU Eletricidade",            categoria: "eletricidade",   nif: null, email: null, telefone: null, avaliacao: 3.8 },
  { nome: "Iberdrola",                  categoria: "eletricidade",   nif: null, email: null, telefone: null, avaliacao: 3.7 },
  { nome: "Limpeza Urbaniz. Fonte",     categoria: "limpeza",        nif: null, email: null, telefone: null, avaliacao: 4.0 },
  { nome: "Jardinagem",                 categoria: "jardim",         nif: null, email: null, telefone: null, avaliacao: 4.0 },
  { nome: "Manutenção Elevadores",      categoria: "elevadores",     nif: null, email: null, telefone: null, avaliacao: 3.8 },
  { nome: "Admin Demo",                 categoria: "administracao",  nif: null, email: null, telefone: null, avaliacao: 4.5 },
  { nome: "Admin Demo B",               categoria: "administracao",  nif: null, email: null, telefone: null, avaliacao: 4.5 },
  { nome: "Admin Demo C",               categoria: "administracao",  nif: null, email: null, telefone: null, avaliacao: 4.5 },
];

// Despesas reais dos movimentos 2025-2026 (saídas categorizadas)
const DESPESAS_SEED = [
  // 2025
  { descricao: "Limpeza Urbaniz. Fonte - Janeiro 2025",      categoria: "limpeza",       valor: 140.00, data: new Date("2025-01-31"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte - Fevereiro 2025",    categoria: "limpeza",       valor: 140.00, data: new Date("2025-02-28"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte - Março 2025",        categoria: "limpeza",       valor: 140.00, data: new Date("2025-03-31"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte - Abril 2025",        categoria: "limpeza",       valor: 140.00, data: new Date("2025-04-30"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte - Maio 2025",         categoria: "limpeza",       valor: 140.00, data: new Date("2025-05-31"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte - Junho 2025",        categoria: "limpeza",       valor: 140.00, data: new Date("2025-06-30"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte - Julho 2025",        categoria: "limpeza",       valor: 140.00, data: new Date("2025-07-31"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte - Agosto 2025",       categoria: "limpeza",       valor: 140.00, data: new Date("2025-08-31"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte - Setembro 2025",     categoria: "limpeza",       valor: 140.00, data: new Date("2025-09-30"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte - Outubro 2025",      categoria: "limpeza",       valor: 140.00, data: new Date("2025-10-31"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte - Novembro 2025",     categoria: "limpeza",       valor: 140.00, data: new Date("2025-11-28"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte - Dezembro 2025",     categoria: "limpeza",       valor: 140.00, data: new Date("2025-12-29"), recorrente: true },
  { descricao: "Jardinagem - Janeiro 2025",                  categoria: "jardim",        valor: 104.55, data: new Date("2025-01-15"), recorrente: true },
  { descricao: "Jardinagem - Março 2025",                    categoria: "jardim",        valor: 104.55, data: new Date("2025-03-15"), recorrente: true },
  { descricao: "Jardinagem - Maio 2025",                     categoria: "jardim",        valor: 104.55, data: new Date("2025-05-15"), recorrente: true },
  { descricao: "Jardinagem - Julho 2025",                    categoria: "jardim",        valor: 104.55, data: new Date("2025-07-15"), recorrente: true },
  { descricao: "Jardinagem - Setembro 2025",                 categoria: "jardim",        valor: 104.55, data: new Date("2025-09-15"), recorrente: true },
  { descricao: "Jardinagem - Novembro 2025",                 categoria: "jardim",        valor: 104.55, data: new Date("2025-11-15"), recorrente: true },
  { descricao: "Elevadores - Fatura FT 2025-780",            categoria: "elevadores",    valor: 140.22, data: new Date("2025-12-09"), recorrente: false },
  { descricao: "Elevadores - Fatura FT 2025-781",            categoria: "elevadores",    valor: 140.22, data: new Date("2025-12-09"), recorrente: false },
  { descricao: "Elevadores - Fatura FT 2025-782",            categoria: "elevadores",    valor: 140.22, data: new Date("2025-12-09"), recorrente: false },
  { descricao: "Água INDAQUA - Dezembro 2025",               categoria: "agua",          valor: 96.30,  data: new Date("2025-12-12"), recorrente: true },
  { descricao: "Água INDAQUA Jardim - Dezembro 2025",        categoria: "agua",          valor: 60.75,  data: new Date("2025-12-12"), recorrente: true },
  { descricao: "Água INDAQUA Piscina - Dezembro 2025",       categoria: "agua",          valor: 47.39,  data: new Date("2025-12-12"), recorrente: true },
  { descricao: "SU Eletricidade A - Dezembro 2025",          categoria: "eletricidade",  valor: 66.40,  data: new Date("2025-12-17"), recorrente: true },
  { descricao: "SU Eletricidade B - Dezembro 2025",          categoria: "eletricidade",  valor: 47.32,  data: new Date("2025-12-17"), recorrente: true },
  { descricao: "SU Eletricidade C - Dezembro 2025",          categoria: "eletricidade",  valor: 46.31,  data: new Date("2025-12-17"), recorrente: true },
  { descricao: "Iberdrola A - Dezembro 2025",                categoria: "eletricidade",  valor: 40.88,  data: new Date("2025-12-02"), recorrente: true },
  { descricao: "Iberdrola B - Dezembro 2025",                categoria: "eletricidade",  valor: 40.50,  data: new Date("2025-12-02"), recorrente: true },
  { descricao: "Honorários Administração - Dezembro 2025",   categoria: "administracao", valor: 138.00, data: new Date("2025-12-15"), recorrente: true },
  // 2026
  { descricao: "Limpeza Urbaniz. Fonte - Janeiro 2026",      categoria: "limpeza",       valor: 150.00, data: new Date("2026-01-28"), recorrente: true },
  { descricao: "Jardinagem - Janeiro 2026",                  categoria: "jardim",        valor: 104.55, data: new Date("2026-01-08"), recorrente: true },
  { descricao: "SU Eletricidade A - Janeiro 2026",           categoria: "eletricidade",  valor: 62.12,  data: new Date("2026-01-15"), recorrente: true },
  { descricao: "SU Eletricidade B - Janeiro 2026",           categoria: "eletricidade",  valor: 44.47,  data: new Date("2026-01-15"), recorrente: true },
  { descricao: "SU Eletricidade C - Janeiro 2026",           categoria: "eletricidade",  valor: 43.86,  data: new Date("2026-01-15"), recorrente: true },
  { descricao: "Iberdrola A - Janeiro 2026",                 categoria: "eletricidade",  valor: 71.67,  data: new Date("2026-01-12"), recorrente: true },
  { descricao: "Iberdrola B - Janeiro 2026",                 categoria: "eletricidade",  valor: 71.67,  data: new Date("2026-01-12"), recorrente: true },
  { descricao: "Iberdrola C - Janeiro 2026",                 categoria: "eletricidade",  valor: 65.26,  data: new Date("2026-01-09"), recorrente: true },
  { descricao: "Água INDAQUA - Janeiro 2026",                categoria: "agua",          valor: 48.92,  data: new Date("2026-01-14"), recorrente: true },
  { descricao: "Honorários Administração - Janeiro 2026",    categoria: "administracao", valor: 138.00, data: new Date("2026-01-15"), recorrente: true },
  // Fevereiro 2026 — dados reais do extrato bancário
  { descricao: "Limpeza Urbaniz. Fonte - Fevereiro 2026",          categoria: "limpeza",       valor: 140.00,  data: new Date("2026-02-28"), recorrente: true },
  { descricao: "Jardim Solar - Fevereiro 2026",                    categoria: "jardim",        valor: 180.00,  data: new Date("2026-02-14"), recorrente: true },
  { descricao: "Jardineiro - Fevereiro 2026",                      categoria: "jardim",        valor: 200.00,  data: new Date("2026-02-14"), recorrente: true },
  { descricao: "Urbz Fonte Jardim - Fevereiro 2026",               categoria: "jardim",        valor: 110.70,  data: new Date("2026-02-14"), recorrente: true },
  { descricao: "Elevadores - Manutenção (Fev 2026)",               categoria: "elevadores",    valor: 1162.35, data: new Date("2026-02-15"), recorrente: false },
  { descricao: "Manutenção Equipamento A - Fevereiro 2026",        categoria: "manutencao",    valor: 75.00,   data: new Date("2026-02-24"), recorrente: true },
  { descricao: "Manutenção Equipamento B - Fevereiro 2026",        categoria: "manutencao",    valor: 75.00,   data: new Date("2026-02-14"), recorrente: true },
  { descricao: "Manutenção Equipamento C - Fevereiro 2026",        categoria: "manutencao",    valor: 75.00,   data: new Date("2026-02-07"), recorrente: true },
  { descricao: "Manutenção Equipamento D - Fevereiro 2026",        categoria: "manutencao",    valor: 75.00,   data: new Date("2026-02-01"), recorrente: true },
  { descricao: "Honorários Administração - Fevereiro 2026",        categoria: "administracao", valor: 141.45,  data: new Date("2026-02-15"), recorrente: true },
  { descricao: "Iberdrola - Fevereiro 2026",                       categoria: "eletricidade",  valor: 45.16,   data: new Date("2026-02-27"), recorrente: true },
  { descricao: "EDP A - Fevereiro 2026",                           categoria: "eletricidade",  valor: 67.36,   data: new Date("2026-02-14"), recorrente: true },
  { descricao: "EDP B - Fevereiro 2026",                           categoria: "eletricidade",  valor: 77.89,   data: new Date("2026-02-14"), recorrente: true },
  { descricao: "EDP C - Fevereiro 2026",                           categoria: "eletricidade",  valor: 68.44,   data: new Date("2026-02-14"), recorrente: true },
  { descricao: "Água INDAQUA A - Fevereiro 2026",                  categoria: "agua",          valor: 91.67,   data: new Date("2026-02-14"), recorrente: true },
  { descricao: "Água INDAQUA B - Fevereiro 2026",                  categoria: "agua",          valor: 12.03,   data: new Date("2026-02-14"), recorrente: true },
  { descricao: "Água INDAQUA C - Fevereiro 2026",                  categoria: "agua",          valor: 8.99,    data: new Date("2026-02-14"), recorrente: true },
  { descricao: "Água INDAQUA D - Fevereiro 2026",                  categoria: "agua",          valor: 50.99,   data: new Date("2026-02-14"), recorrente: true },
  { descricao: "Água INDAQUA E - Fevereiro 2026",                  categoria: "agua",          valor: 49.97,   data: new Date("2026-02-14"), recorrente: true },
  // Março 2026 — dados reais do extrato bancário
  { descricao: "Limpeza Urbaniz. Fonte - Março 2026",              categoria: "limpeza",       valor: 140.00,  data: new Date("2026-03-15"), recorrente: true },
  { descricao: "Manutenção Equipamento A - Março 2026",            categoria: "manutencao",    valor: 75.00,   data: new Date("2026-03-15"), recorrente: true },
  { descricao: "Manutenção Equipamento B - Março 2026",            categoria: "manutencao",    valor: 75.00,   data: new Date("2026-03-07"), recorrente: true },
  { descricao: "Manutenção Equipamento C - Março 2026",            categoria: "manutencao",    valor: 75.00,   data: new Date("2026-03-01"), recorrente: true },
  { descricao: "Manutenção Equipamento D - Março 2026",            categoria: "manutencao",    valor: 75.00,   data: new Date("2026-03-22"), recorrente: true },
  { descricao: "Manutenção Equipamento E - Março 2026",            categoria: "manutencao",    valor: 75.00,   data: new Date("2026-03-29"), recorrente: true },
  { descricao: "Honorários Administração - Março 2026",            categoria: "administracao", valor: 141.45,  data: new Date("2026-03-03"), recorrente: true },
  { descricao: "EDP A - Março 2026",                               categoria: "eletricidade",  valor: 48.81,   data: new Date("2026-03-15"), recorrente: true },
  { descricao: "EDP B - Março 2026",                               categoria: "eletricidade",  valor: 58.90,   data: new Date("2026-03-15"), recorrente: true },
  { descricao: "EDP C - Março 2026",                               categoria: "eletricidade",  valor: 47.83,   data: new Date("2026-03-15"), recorrente: true },
  { descricao: "EDP D - Março 2026",                               categoria: "eletricidade",  valor: 53.97,   data: new Date("2026-03-08"), recorrente: true },
  { descricao: "EDP E - Março 2026",                               categoria: "eletricidade",  valor: 65.72,   data: new Date("2026-03-08"), recorrente: true },
  { descricao: "EDP F - Março 2026",                               categoria: "eletricidade",  valor: 52.98,   data: new Date("2026-03-08"), recorrente: true },
  { descricao: "Iberdrola - Março 2026",                           categoria: "eletricidade",  valor: 102.86,  data: new Date("2026-03-27"), recorrente: true },
  { descricao: "Água INDAQUA - Março 2026",                        categoria: "agua",          valor: 45.86,   data: new Date("2026-03-14"), recorrente: true },
  // Abril 2026 — dados reais do extrato bancário
  { descricao: "Limpeza Urbaniz. Fonte A - Abril 2026",            categoria: "limpeza",       valor: 101.47,  data: new Date("2026-04-15"), recorrente: true },
  { descricao: "Limpeza Urbaniz. Fonte B - Abril 2026",            categoria: "limpeza",       valor: 140.00,  data: new Date("2026-04-07"), recorrente: true },
  { descricao: "LIMPZ URB FONTE - Abril 2026",                     categoria: "limpeza",       valor: 400.00,  data: new Date("2026-04-02"), recorrente: false },
  { descricao: "Manutenção Equipamento A - Abril 2026",            categoria: "manutencao",    valor: 75.00,   data: new Date("2026-04-15"), recorrente: true },
  { descricao: "Manutenção Equipamento B - Abril 2026",            categoria: "manutencao",    valor: 75.00,   data: new Date("2026-04-07"), recorrente: true },
  { descricao: "Manutenção Equipamento C - Abril 2026",            categoria: "manutencao",    valor: 75.00,   data: new Date("2026-04-01"), recorrente: true },
  { descricao: "Manutenção Equipamento D - Abril 2026",            categoria: "manutencao",    valor: 75.00,   data: new Date("2026-04-22"), recorrente: true },
  { descricao: "Honorários Administração - Abril 2026",            categoria: "administracao", valor: 141.45,  data: new Date("2026-04-15"), recorrente: true },
  { descricao: "EDP A - Abril 2026",                               categoria: "eletricidade",  valor: 49.01,   data: new Date("2026-04-15"), recorrente: true },
  { descricao: "EDP B - Abril 2026",                               categoria: "eletricidade",  valor: 49.42,   data: new Date("2026-04-15"), recorrente: true },
  { descricao: "Iberdrola - Abril 2026",                           categoria: "eletricidade",  valor: 62.02,   data: new Date("2026-04-14"), recorrente: true },
  { descricao: "Água INDAQUA A - Abril 2026",                      categoria: "agua",          valor: 105.27,  data: new Date("2026-04-14"), recorrente: true },
  { descricao: "Água INDAQUA B - Abril 2026",                      categoria: "agua",          valor: 3.03,    data: new Date("2026-04-14"), recorrente: true },
  { descricao: "Água INDAQUA C - Abril 2026",                      categoria: "agua",          valor: 66.72,   data: new Date("2026-04-14"), recorrente: true },
  { descricao: "Água INDAQUA D - Abril 2026",                      categoria: "agua",          valor: 74.51,   data: new Date("2026-04-14"), recorrente: true },
  // Maio 2026 — dados reais do extrato bancário
  { descricao: "Limpeza Urbaniz. Fonte - Maio 2026",               categoria: "limpeza",       valor: 140.00,  data: new Date("2026-05-15"), recorrente: true },
  { descricao: "Manutenção Equipamento - Maio 2026",               categoria: "manutencao",    valor: 75.00,   data: new Date("2026-05-15"), recorrente: true },
  { descricao: "Honorários Administração - Maio 2026",             categoria: "administracao", valor: 141.45,  data: new Date("2026-05-02"), recorrente: true },
  { descricao: "EDP A - Maio 2026",                                categoria: "eletricidade",  valor: 52.60,   data: new Date("2026-05-15"), recorrente: true },
  { descricao: "EDP B - Maio 2026",                                categoria: "eletricidade",  valor: 51.40,   data: new Date("2026-05-15"), recorrente: true },
  { descricao: "EDP C (garagem) - Maio 2026",                      categoria: "eletricidade",  valor: 66.09,   data: new Date("2026-05-14"), recorrente: true },
  { descricao: "Iberdrola - Maio 2026",                            categoria: "eletricidade",  valor: 70.85,   data: new Date("2026-05-14"), recorrente: true },
  { descricao: "EDP D - Maio 2026",                                categoria: "eletricidade",  valor: 53.58,   data: new Date("2026-05-08"), recorrente: true },
  { descricao: "EDP E - Maio 2026",                                categoria: "eletricidade",  valor: 52.99,   data: new Date("2026-05-08"), recorrente: true },
  { descricao: "Água INDAQUA - Maio 2026",                         categoria: "agua",          valor: 47.39,   data: new Date("2026-05-14"), recorrente: true },
];

// Pagamentos reais das frações extraídos dos movimentos CSV 2025+2026
// Estrutura: { fracao, mes, ano, valor, data }
const PAGAMENTOS_REAIS = [
  // Janeiro 2026
  { fracao: "Z",  mes: 1, ano: 2026, valor: 62.04, data: new Date("2026-01-30"), metodo: "transferência" },
  { fracao: "T",  mes: 1, ano: 2026, valor: 43.31, data: new Date("2026-01-21"), metodo: "transferência" },
  { fracao: "D",  mes: 1, ano: 2026, valor: 1.82,  data: new Date("2026-01-21"), metodo: "transferência" },
  { fracao: "AD", mes: 1, ano: 2026, valor: 86.08, data: new Date("2026-01-26"), metodo: "transferência" },
  { fracao: "AC", mes: 1, ano: 2026, valor: 125.04,data: new Date("2026-01-21"), metodo: "transferência" },
  { fracao: "AH", mes: 1, ano: 2026, valor: 46.08, data: new Date("2026-01-09"), metodo: "transferência" },
  { fracao: "AG", mes: 1, ano: 2026, valor: 39.83, data: new Date("2026-01-08"), metodo: "transferência" },
  { fracao: "U",  mes: 1, ano: 2026, valor: 64.36, data: new Date("2026-01-08"), metodo: "transferência" },
  { fracao: "AI", mes: 1, ano: 2026, valor: 40.33, data: new Date("2026-01-08"), metodo: "transferência" },
  { fracao: "S",  mes: 1, ano: 2026, valor: 36.38, data: new Date("2026-01-07"), metodo: "transferência" },
  { fracao: "AE", mes: 1, ano: 2026, valor: 41.62, data: new Date("2026-01-07"), metodo: "transferência" },
  { fracao: "B",  mes: 1, ano: 2026, valor: 1.65,  data: new Date("2026-01-07"), metodo: "transferência" },
  { fracao: "O",  mes: 1, ano: 2026, valor: 46.98, data: new Date("2026-01-07"), metodo: "transferência" },
  { fracao: "X",  mes: 1, ano: 2026, valor: 88.02, data: new Date("2026-01-06"), metodo: "transferência" },
  { fracao: "V",  mes: 1, ano: 2026, valor: 38.30, data: new Date("2026-01-06"), metodo: "transferência" },
  { fracao: "AJ", mes: 1, ano: 2026, valor: 38.89, data: new Date("2026-01-05"), metodo: "transferência" },
  { fracao: "J",  mes: 1, ano: 2026, valor: 43.65, data: new Date("2026-01-05"), metodo: "transferência" },
  { fracao: "Q",  mes: 1, ano: 2026, valor: 41.78, data: new Date("2026-01-05"), metodo: "transferência" },
  { fracao: "H",  mes: 1, ano: 2026, valor: 9.77,  data: new Date("2026-01-05"), metodo: "transferência" },
  { fracao: "I",  mes: 1, ano: 2026, valor: 12.66, data: new Date("2026-01-05"), metodo: "transferência" },
  { fracao: "E",  mes: 1, ano: 2026, valor: 1.73,  data: new Date("2026-01-05"), metodo: "transferência" },
  { fracao: "F",  mes: 1, ano: 2026, valor: 1.87,  data: new Date("2026-01-05"), metodo: "transferência" },
  { fracao: "P",  mes: 1, ano: 2026, valor: 48.71, data: new Date("2026-01-05"), metodo: "transferência" },
  { fracao: "M",  mes: 1, ano: 2026, valor: 44.44, data: new Date("2026-01-02"), metodo: "transferência" },
  { fracao: "AA", mes: 1, ano: 2026, valor: 39.44, data: new Date("2026-01-02"), metodo: "transferência" },
  { fracao: "AB", mes: 1, ano: 2026, valor: 39.37, data: new Date("2026-01-02"), metodo: "transferência" },
  { fracao: "AF", mes: 1, ano: 2026, valor: 39.61, data: new Date("2026-01-02"), metodo: "transferência" },
  // Dezembro 2025
  { fracao: "Z",  mes: 12, ano: 2025, valor: 62.04, data: new Date("2025-12-30"), metodo: "transferência" },
  { fracao: "R",  mes: 12, ano: 2025, valor: 63.84, data: new Date("2025-12-30"), metodo: "transferência" },
  { fracao: "T",  mes: 12, ano: 2025, valor: 43.34, data: new Date("2025-12-22"), metodo: "transferência" },
  { fracao: "D",  mes: 12, ano: 2025, valor: 1.79,  data: new Date("2025-12-22"), metodo: "transferência" },
  { fracao: "O",  mes: 12, ano: 2025, valor: 46.98, data: new Date("2025-12-10"), metodo: "transferência" },
  { fracao: "Q",  mes: 12, ano: 2025, valor: 41.78, data: new Date("2025-12-09"), metodo: "transferência" },
  { fracao: "AI", mes: 12, ano: 2025, valor: 40.33, data: new Date("2025-12-09"), metodo: "transferência" },
  { fracao: "U",  mes: 12, ano: 2025, valor: 64.36, data: new Date("2025-12-09"), metodo: "transferência" },
  { fracao: "AH", mes: 12, ano: 2025, valor: 46.08, data: new Date("2025-12-09"), metodo: "transferência" },
  { fracao: "V",  mes: 12, ano: 2025, valor: 38.30, data: new Date("2025-12-09"), metodo: "transferência" },
  { fracao: "S",  mes: 12, ano: 2025, valor: 36.38, data: new Date("2025-12-09"), metodo: "transferência" },
  { fracao: "AB", mes: 12, ano: 2025, valor: 39.37, data: new Date("2025-12-05"), metodo: "transferência" },
  { fracao: "AE", mes: 12, ano: 2025, valor: 41.63, data: new Date("2025-12-04"), metodo: "transferência" },
  { fracao: "B",  mes: 12, ano: 2025, valor: 1.64,  data: new Date("2025-12-04"), metodo: "transferência" },
  { fracao: "AJ", mes: 12, ano: 2025, valor: 38.89, data: new Date("2025-12-03"), metodo: "transferência" },
  { fracao: "AA", mes: 12, ano: 2025, valor: 19.86, data: new Date("2025-12-03"), metodo: "transferência" },
  { fracao: "AG", mes: 12, ano: 2025, valor: 39.83, data: new Date("2025-12-02"), metodo: "transferência" },
  { fracao: "P",  mes: 12, ano: 2025, valor: 48.71, data: new Date("2025-12-02"), metodo: "transferência" },
  { fracao: "M",  mes: 12, ano: 2025, valor: 44.44, data: new Date("2025-12-02"), metodo: "transferência" },
  { fracao: "H",  mes: 12, ano: 2025, valor: 9.75,  data: new Date("2025-12-02"), metodo: "transferência" },
  { fracao: "I",  mes: 12, ano: 2025, valor: 12.68, data: new Date("2025-12-02"), metodo: "transferência" },
  { fracao: "AF", mes: 12, ano: 2025, valor: 39.61, data: new Date("2025-12-02"), metodo: "transferência" },
  { fracao: "R",  mes: 12, ano: 2025, valor: 63.84, data: new Date("2025-12-02"), metodo: "transferência" },
  { fracao: "E",  mes: 12, ano: 2025, valor: 1.73,  data: new Date("2025-12-02"), metodo: "transferência" },
  { fracao: "F",  mes: 12, ano: 2025, valor: 1.87,  data: new Date("2025-12-02"), metodo: "transferência" },
  { fracao: "J",  mes: 12, ano: 2025, valor: 43.65, data: new Date("2025-12-02"), metodo: "transferência" },
  { fracao: "Z",  mes: 12, ano: 2025, valor: 62.04, data: new Date("2025-12-02"), metodo: "transferência" },
  // Novembro 2025
  { fracao: "S",  mes: 11, ano: 2025, valor: 36.38, data: new Date("2025-11-28"), metodo: "transferência" },
  { fracao: "J",  mes: 11, ano: 2025, valor: 43.65, data: new Date("2025-11-10"), metodo: "transferência" },
  { fracao: "R",  mes: 11, ano: 2025, valor: 63.84, data: new Date("2025-11-05"), metodo: "transferência" },
  { fracao: "V",  mes: 11, ano: 2025, valor: 38.30, data: new Date("2025-11-03"), metodo: "transferência" },
  { fracao: "AE", mes: 11, ano: 2025, valor: 55.97, data: new Date("2025-11-08"), metodo: "transferência" },
  { fracao: "P",  mes: 11, ano: 2025, valor: 60.80, data: new Date("2025-11-06"), metodo: "transferência" },
  { fracao: "AA", mes: 11, ano: 2025, valor: 49.23, data: new Date("2025-11-06"), metodo: "numerário" },
  { fracao: "U",  mes: 11, ano: 2025, valor: 80.33, data: new Date("2025-11-11"), metodo: "transferência" },
  { fracao: "AF", mes: 11, ano: 2025, valor: 49.44, data: new Date("2025-11-05"), metodo: "transferência" },
  // Outubro 2025
  { fracao: "J",  mes: 10, ano: 2025, valor: 43.65, data: new Date("2025-10-02"), metodo: "transferência" },
  { fracao: "S",  mes: 10, ano: 2025, valor: 45.41, data: new Date("2025-10-09"), metodo: "transferência" },
  { fracao: "V",  mes: 10, ano: 2025, valor: 47.81, data: new Date("2025-10-11"), metodo: "transferência" },
  { fracao: "AA", mes: 10, ano: 2025, valor: 49.23, data: new Date("2025-10-04"), metodo: "numerário" },
  { fracao: "U",  mes: 10, ano: 2025, valor: 80.33, data: new Date("2025-10-09"), metodo: "transferência" },
  { fracao: "AF", mes: 10, ano: 2025, valor: 49.44, data: new Date("2025-10-15"), metodo: "transferência" },
  { fracao: "R",  mes: 10, ano: 2025, valor: 50.00, data: new Date("2025-10-03"), metodo: "transferência" },
  { fracao: "AE", mes: 10, ano: 2025, valor: 55.97, data: new Date("2025-10-08"), metodo: "transferência" },
  { fracao: "P",  mes: 10, ano: 2025, valor: 60.80, data: new Date("2025-10-08"), metodo: "numerário" },
];

export const seed = new Hono()
  .post("/", async (c) => {
    // Limpar dados existentes (na ordem correta para FK)
    await db.delete(schema.recibos);
    await db.delete(schema.quotas);
    await db.delete(schema.despesas);
    await db.delete(schema.fracoes);
    await db.delete(schema.fornecedores);

    // Inserir fornecedores
    const fornecedoresInseridos = await db.insert(schema.fornecedores)
      .values(FORNECEDORES_SEED)
      .returning();

    const getFornecedor = (cat: string) =>
      fornecedoresInseridos.find(f => f.categoria === cat)?.id ?? null;

    // Inserir frações
    const fracoesInseridas = await db.insert(schema.fracoes)
      .values(FRACOES_SEED.map(f => ({
        ...f,
        ativo: true,
        notas: null,
        proprietarioEmail: null,
        proprietarioTelefone: null,
        telegramId: null,
        andar: null,
      })))
      .returning();

    const getFracao = (numero: string) =>
      fracoesInseridas.find(f => f.numero === numero);

    // Mapear fornecedores por categoria para despesas
    const catToFornecedor: Record<string, string | null> = {
      limpeza: getFornecedor("limpeza"),
      jardim: getFornecedor("jardim"),
      elevadores: getFornecedor("elevadores"),
      agua: getFornecedor("agua"),
      eletricidade: getFornecedor("eletricidade"),
      administracao: getFornecedor("administracao"),
    };

    // Inserir despesas reais
    await db.insert(schema.despesas).values(
      DESPESAS_SEED.map(d => ({
        descricao: d.descricao,
        categoria: d.categoria,
        valor: d.valor,
        data: d.data,
        recorrente: d.recorrente,
        fornecedorId: catToFornecedor[d.categoria] ?? null,
        notas: null,
        faturaUrl: null,
        subcategoria: null,
      }))
    );

    // Gerar quotas mensais para todos os meses 2025 + Jan 2026
    const meses = [
      { mes: 1, ano: 2025 }, { mes: 2, ano: 2025 }, { mes: 3, ano: 2025 },
      { mes: 4, ano: 2025 }, { mes: 5, ano: 2025 }, { mes: 6, ano: 2025 },
      { mes: 7, ano: 2025 }, { mes: 8, ano: 2025 }, { mes: 9, ano: 2025 },
      { mes: 10, ano: 2025 }, { mes: 11, ano: 2025 }, { mes: 12, ano: 2025 },
      { mes: 1, ano: 2026 }, { mes: 2, ano: 2026 }, { mes: 3, ano: 2026 },
      { mes: 4, ano: 2026 }, { mes: 5, ano: 2026 },
    ];

    // Indexar pagamentos reais por fração+mes+ano
    const pagIdx: Record<string, typeof PAGAMENTOS_REAIS[0]> = {};
    for (const pag of PAGAMENTOS_REAIS) {
      pagIdx[`${pag.fracao}-${pag.mes}-${pag.ano}`] = pag;
    }

    // Frações com morosos conhecidos (Maio 2026 - mês atual, sem pagamento registado)
    const MOROSOS_MAIO_2026 = new Set(["L", "N", "G", "AC", "AD", "A", "C"]);

    const quotasToInsert = [];
    for (const { mes, ano } of meses) {
      const isAtual = mes === 5 && ano === 2026;
      const isJan2026 = mes === 1 && ano === 2026;

      for (const fracao of fracoesInseridas) {
        const key = `${fracao.numero}-${mes}-${ano}`;
        const pagReal = pagIdx[key];

        // Para meses com dados reais: usar pagamento real se existir
        let pago: boolean;
        let dataPagamento: Date | null;
        let metodoPagamento: string | null;
        let valor = fracao.quotaMensal;

        if (pagReal) {
          pago = true;
          valor = pagReal.valor;
          dataPagamento = pagReal.data;
          metodoPagamento = pagReal.metodo;
        } else if (isAtual) {
          // Maio 2026 - alguns morosos conhecidos
          pago = !MOROSOS_MAIO_2026.has(fracao.numero);
          dataPagamento = pago ? new Date(2026, 4, Math.floor(Math.random() * 10) + 1) : null;
          metodoPagamento = pago ? "transferência" : null;
        } else if (isJan2026) {
          // Janeiro 2026 - frações sem registo são morosas
          pago = !!pagReal;
          dataPagamento = null;
          metodoPagamento = null;
        } else {
          // 2025 sem dados explícitos — assumir pago (maioria paga)
          const pct = Math.random();
          pago = pct > 0.08; // ~92% taxa de pagamento histórica
          dataPagamento = pago ? new Date(ano, mes - 1, Math.floor(Math.random() * 12) + 1) : null;
          metodoPagamento = pago ? ["transferência", "mbway", "numerário"][Math.floor(Math.random() * 3)] : null;
        }

        quotasToInsert.push({
          fracaoId: fracao.id,
          tipo: "condominio" as const,
          mes,
          ano,
          valor,
          fundoReserva: Math.round(valor * 0.10 * 100) / 100,
          pago,
          dataPagamento,
          metodoPagamento,
          observacoes: null,
          quotaTipoId: null,
        });
      }
    }

    await db.insert(schema.quotas).values(quotasToInsert);

    return c.json({
      ok: true,
      fracoes: fracoesInseridas.length,
      fornecedores: fornecedoresInseridos.length,
      despesas: DESPESAS_SEED.length,
      quotas: quotasToInsert.length,
    });
  });
