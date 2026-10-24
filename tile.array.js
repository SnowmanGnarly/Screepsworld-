/*
 * A two dimensional array that holds information for x and y coordinates. 
 */

class TileArray {
	
	constructor(width = 0, height = 0) {
		this.width = width;
		this.height = height;
		
		this._array = new Array(width);
		for (var x = 0; x < width; x++) {
			this._array[x] = new Array(height);
		}
	}
	
	/*
	 * Sets the value on the coordinates x and y.
	 */
	
	set(x, y, value) {
		this._array[x][y] = value;
	}

	/*
	 * Returns the value on the coordinates x and y.
	 */
	
	get(x, y) {
		return this._array[x][y];
	}

	/*
	 * Returns a single string from the array.
	 */
	
	toCompactString(opt = {}) {
		var defaultOpt = {
			paddingChar: ' ',
		};
		opt = Object.assign(defaultOpt, opt);
		
		var flatMap = this._flatMap();
		var maxLength = Math.max(...flatMap.map(value => value ? ("" + value).length : 0));
		return flatMap.map(value =>  value ? ("" + value).padStart(maxLength, opt.paddingChar) : opt.paddingChar.repeat(maxLength)).join('');
	}

	/*
	 * Sets the array values from a single string.
	 */

	fromCompactString(string, opt = {}) {
		var defaultOpt = {
			paddingChar: ' ',
			emptyValue: '',
		};
		opt = Object.assign(defaultOpt, opt);
		var cellCount = this.width * this.height;
		if (cellCount <= 0 || string.length % cellCount != 0) {
			throw new Error('Compact tile string does not match array dimensions.');
		}
		var valueLength = string.length / cellCount;
		if (valueLength < 1) {
			throw new Error('Compact tile string has empty cells.');
		}

		for (var y = 0; y < this.height; y++) {
			for (var x = 0; x < this.width; x++) {
				var position = (x + y * this.width) * valueLength;
				var value = string.substring(position, position + valueLength);
				if (value == opt.paddingChar.repeat(valueLength)) {
					this.set(x, y, opt.emptyValue);
					continue;
				}
				while (value.charAt(0) == opt.paddingChar) {
					value = value.substring(1);
				}
				this.set(x, y, value);
			}
		}
	}
	
	_flatMap() {
		var result = [];
		for (var y = 0; y < this.height; y++) {
			for (var x = 0; x < this.width; x++) {
				result.push(this._array[x][y]);
			}
		}
		return result;
	}
}

module.exports = TileArray;