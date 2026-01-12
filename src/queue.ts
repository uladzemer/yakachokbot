type GenericFunction = (...parameters: unknown[]) => Promise<unknown>

export class Queue {
	private queue: GenericFunction[] = []
	private active = 0
	private concurrency: number

	constructor(concurrency = 5) {
		this.concurrency = concurrency
	}

	private run = async (executor: GenericFunction) => {
		this.active++
		try {
			await executor()
		} catch (error) {
			console.log(error)
		} finally {
			this.active--
			this.next()
		}
	}

	private next = () => {
		while (this.active < this.concurrency && this.queue.length > 0) {
			const nextUp = this.queue.shift()
			if (nextUp) {
				this.run(nextUp)
			}
		}
	}

	add = <F extends GenericFunction>(executor: F) => {
		this.queue.push(executor)
		this.next()
	}
}
