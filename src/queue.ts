type GenericFunction = (...parameters: unknown[]) => Promise<unknown>
type QueueEntry = { id: string; executor: GenericFunction }

export class Queue {
	private queue: QueueEntry[] = []
	private active = 0
	private concurrency: number

	constructor(concurrency = 5) {
		this.concurrency = concurrency
	}

	private run = async (entry: QueueEntry) => {
		this.active++
		try {
			await entry.executor()
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

	add = <F extends GenericFunction>(executor: F, id: string) => {
		this.queue.push({ id, executor })
		this.next()
		return id
	}

	remove = (predicate: (entry: QueueEntry) => boolean) => {
		const removed: QueueEntry[] = []
		this.queue = this.queue.filter((entry) => {
			if (predicate(entry)) {
				removed.push(entry)
				return false
			}
			return true
		})
		return removed
	}

	clear = () => {
		const removed = this.queue
		this.queue = []
		return removed
	}

	getPendingCount = () => this.queue.length
	getActiveCount = () => this.active
}
