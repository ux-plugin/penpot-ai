import { createSignal } from 'solid-js'
import { Button } from './components/ui/button'

function App() {
  const [count, setCount] = createSignal(0)
  function handleClick() {
    parent.postMessage({ pluginMessage: { type: 'create-rectangles', count: count() } }, '*')
  }

  return (
    <div class='flex flex-col w-full h-full bg-slate-300 justify-center items-center'>
      <h2>Rectangle Creator</h2>
      <p>Count: <input id="count" value={count()} onChange={(event) => setCount(+event.target.value)} /></p>
      <Button id="create" onClick={handleClick}>Create</Button>
      <Button id="cancel" onClick={() => alert("canceled operation")}>Cancel</Button>
    </div>
  )
}

export default App
