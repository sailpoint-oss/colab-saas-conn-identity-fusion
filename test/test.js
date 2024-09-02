const max = 100
let count = 0
const results = [0]
const promises = []

const calc = async () => {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.round(600 * Math.random()))
        let max = results[results.length - 1]
        results.push(++max)
    })
}
const resolve = async () => {
    while (++count < max) {
        await calc()
    }

}

while (++count < max) {
    promises.push(calc())
}

Promise.all(promises)
// resolve().then(() => console.log(results))
console.log(results)
