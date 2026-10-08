import React from 'react'
import { createRoot } from 'react-dom/client'
import TestDemoPage from '../src/pages/TestDemoPage.jsx'
import paper from '../src/data/tests/foundation-practice-test-1.json'
import '../src/styles.css'
const test = { ...paper, id: 'isolated-compact-controls-check' }
createRoot(document.getElementById('root')).render(<TestDemoPage test={test} loadKey={() => import('../src/data/tests/foundation-practice-test-1-key.json').then(m => m.default)} />)
